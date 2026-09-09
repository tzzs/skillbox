import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AgentRegistry } from '../agent/index.js'
import type { AgentAdapter, AgentLinkOptions, AgentUnlinkResult } from '../agent/index.js'
import type {
  AgentCapabilities,
  AgentDetectionResult,
  AgentInstalledSkill,
} from '../domain/index.js'
import { withTempDir, createDirLink } from '../fs/test-utils.js'
import { emptyLockfile, readLockfile, writeLockfile } from '../lockfile/index.js'
import { readManifest } from '../manifest/index.js'
import type {
  RegistryProvider,
  NormalizedSource,
  RegistrySearchResult,
  ResolvedSource,
} from '../registry/types.js'
import { installSkill, updateSkill } from './transaction.js'

const GITHUB_SOURCE: NormalizedSource = {
  type: 'github',
  repo: 'acme/skillz',
  path: 'skills/hello',
  ref: 'main',
}

/** Seeds a fake "repository" the provider downloads: `skills/hello/SKILL.md`. */
async function seedRepo(dir: string, marker: string): Promise<void> {
  const skillDir = path.join(dir, 'skills', 'hello')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(skillDir + path.sep + 'SKILL.md', `# hello\n\nmarker: ${marker}\n`, 'utf8')
}

class FakeGithubProvider implements RegistryProvider {
  readonly id = 'github'
  downloads = 0

  constructor(
    private readonly seedDir: string,
    private readonly revision: string,
    private readonly options: { latest?: string; integrity?: string } = {},
  ) {}

  async search(): Promise<RegistrySearchResult[]> {
    return []
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    const resolved: ResolvedSource = { source, revision: this.revision }
    if (this.options.integrity !== undefined) {
      resolved.integrity = this.options.integrity
    }
    return resolved
  }

  async download(source: NormalizedSource, _revision: string, targetDir: string): Promise<void> {
    this.downloads++
    // Real providers materialize the skill *subtree* into `targetDir`.
    const subPath = source.type === 'github' ? source.path : undefined
    const seedRoot =
      subPath === undefined ? this.seedDir : path.join(this.seedDir, ...subPath.split('/'))
    await fs.cp(seedRoot, targetDir, { recursive: true })
  }

  async getLatestRevision(): Promise<string> {
    return this.options.latest ?? this.revision
  }
}

class FakeAgentAdapter implements AgentAdapter {
  readonly name: string
  readonly capabilities: AgentCapabilities = {
    supportsGlobalSkills: true,
    supportsProjectSkills: true,
    supportsSymlinks: true,
    supportsNestedSkillDirectories: false,
    requiresRestartAfterChange: false,
  }
  readonly createdLinks: string[] = []
  readonly removedLinks: string[] = []

  constructor(
    readonly id: string,
    private readonly dir: string,
  ) {
    this.name = id
  }

  async detect(): Promise<AgentDetectionResult> {
    return { detected: true, skillDirectories: [this.dir], confidence: 'high' }
  }

  async getSkillDirectories(): Promise<string[]> {
    return [this.dir]
  }

  async scanSkills(): Promise<AgentInstalledSkill[]> {
    return []
  }

  async linkSkill(source: string, options?: AgentLinkOptions): Promise<void> {
    const name = options?.name ?? 'skill'
    this.createdLinks.push(name)
    await createDirLink(source, path.join(this.dir, name))
  }

  async unlinkSkill(name: string): Promise<AgentUnlinkResult> {
    this.removedLinks.push(name)
    await fs.rm(path.join(this.dir, name), { recursive: true, force: true })
    return { name, path: path.join(this.dir, name), removed: true, reason: 'managed' }
  }
}

describe('updateSkill', () => {
  it('no-ops when the locked revision is already the latest', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      const agentDir = path.join(dir, 'agents', 'claude')
      await fs.mkdir(repoRoot, { recursive: true })
      await fs.mkdir(agentDir, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed, 'v1')
      const adapter = new FakeAgentAdapter('claude', agentDir)
      const agentRegistry = new AgentRegistry([adapter])

      const installed = await installSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        provider: new FakeGithubProvider(seed, 'abc123'),
        homeRoot,
        targetAgents: ['claude'],
        agentRegistry,
      })
      expect(installed.revision).toBe('abc123')

      const noopProvider = new FakeGithubProvider(seed, 'abc123', { latest: 'abc123' })
      const result = await updateSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        provider: noopProvider,
        homeRoot,
        agentRegistry,
      })

      // Same revision → no-op: current state returned, nothing re-downloaded.
      expect(result.revision).toBe('abc123')
      expect(result.mode).toBe('managed')
      expect(result.integrity).toBe(installed.integrity)
      expect(result.agents).toEqual(['claude'])
      expect(result.cacheHit).toBe(false)
      expect(noopProvider.downloads).toBe(0)

      // Lockfile and manifest untouched.
      const lockfile = await readLockfile(repoRoot)
      expect(lockfile.skills.hello?.revision).toBe('abc123')
      expect(lockfile.skills.hello?.integrity).toBe(installed.integrity)
      const manifest = await readManifest(repoRoot)
      expect(manifest.skills.hello?.agents).toEqual(['claude'])
    })
  })

  it('re-runs the transaction on a newer revision, bumping the lockfile and keeping agent links', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      const agentDir = path.join(dir, 'agents', 'claude')
      await fs.mkdir(repoRoot, { recursive: true })
      await fs.mkdir(agentDir, { recursive: true })

      const seedV1 = path.join(dir, 'seed-v1')
      await seedRepo(seedV1, 'v1')
      const adapter = new FakeAgentAdapter('claude', agentDir)
      const agentRegistry = new AgentRegistry([adapter])

      const installed = await installSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        provider: new FakeGithubProvider(seedV1, 'abc123'),
        homeRoot,
        targetAgents: ['claude'],
        agentRegistry,
      })

      const seedV2 = path.join(dir, 'seed-v2')
      await seedRepo(seedV2, 'v2')
      const updateProvider = new FakeGithubProvider(seedV2, 'def456')
      const result = await updateSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        provider: updateProvider,
        homeRoot,
        agentRegistry,
      })

      // New revision installed through the transaction.
      expect(result.revision).toBe('def456')
      expect(result.integrity).not.toBe(installed.integrity)
      expect(result.agents).toEqual(['claude'])
      expect(updateProvider.downloads).toBe(1)

      // Lockfile records the new revision / integrity / upstream.
      const lockfile = await readLockfile(repoRoot)
      expect(lockfile.skills.hello?.revision).toBe('def456')
      expect(lockfile.skills.hello?.integrity).toBe(result.integrity)
      expect(lockfile.skills.hello?.upstream?.baseRevision).toBe('def456')
      expect(lockfile.skills.hello?.mode).toBe('managed')

      // Manifest agents preserved.
      const manifest = await readManifest(repoRoot)
      expect(manifest.skills.hello?.agents).toEqual(['claude'])

      // Materialized content replaced; the agent link still resolves (no duplicate).
      const materialized = await fs.readFile(path.join(result.materializedPath, 'SKILL.md'), 'utf8')
      expect(materialized).toContain('marker: v2')
      expect(adapter.createdLinks).toEqual(['hello'])
      await expect(fs.stat(path.join(agentDir, 'hello'))).resolves.toBeDefined()
    })
  })

  it('throws SKILL_NOT_FOUND when the skill is not installed', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })
      await fs.mkdir(homeRoot, { recursive: true })

      // No lockfile at all.
      await expect(
        updateSkill(GITHUB_SOURCE, { repositoryRoot: repoRoot, homeRoot }),
      ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })

      // A lockfile without the alias.
      await writeLockfile(repoRoot, emptyLockfile())
      await expect(
        updateSkill(GITHUB_SOURCE, { repositoryRoot: repoRoot, homeRoot }),
      ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    })
  })

  it('throws SOURCE_UNSUPPORTED for non-managed skills', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })
      await fs.mkdir(homeRoot, { recursive: true })
      await writeLockfile(repoRoot, {
        lockfileVersion: 1,
        skills: {
          hello: {
            mode: 'local',
            source: { type: 'local', path: path.join(dir, 'hello') },
            integrity: `sha256:${'a'.repeat(64)}`,
          },
        },
      })
      await expect(
        updateSkill(
          { type: 'local', path: path.join(dir, 'hello') },
          { repositoryRoot: repoRoot, homeRoot },
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' })
    })
  })

  it('throws SOURCE_UNSUPPORTED when no provider is wired and none is registered', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })
      await fs.mkdir(homeRoot, { recursive: true })
      await writeLockfile(repoRoot, {
        lockfileVersion: 1,
        skills: {
          hello: {
            mode: 'managed',
            source: { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
            revision: 'abc123',
            integrity: `sha256:${'a'.repeat(64)}`,
          },
        },
      })
      // No provider option and an empty default registry → SOURCE_UNSUPPORTED
      // from `resolveProvider` (the CLI wiring surfaces this until providers
      // are registered).
      await expect(
        updateSkill(GITHUB_SOURCE, { repositoryRoot: repoRoot, homeRoot }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' })
    })
  })
})
