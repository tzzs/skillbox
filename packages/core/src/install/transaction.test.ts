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
import { readLockfile } from '../lockfile/index.js'
import { addSkill, emptyManifest, readManifest, writeManifest } from '../manifest/index.js'
import type {
  RegistryProvider,
  NormalizedSource,
  RegistrySearchResult,
  ResolvedSource,
} from '../registry/types.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { installSkill, defaultAliasFor } from './transaction.js'
import { ManagedCache } from './cache.js'
import { createSkillSourceResolver } from '../sources/index.js'
import type { CanonicalSkillSource, SkillSourceAdapter } from '../sources/types.js'
import { createOperationRuntime } from '../operations/index.js'

const GITHUB_SOURCE: NormalizedSource = {
  type: 'github',
  repo: 'acme/skillz',
  path: 'skills/hello',
  ref: 'main',
}

const GITHUB_PATH_TRAVERSAL: NormalizedSource = {
  type: 'github',
  repo: 'acme/skillz',
  path: '../escape',
  ref: 'main',
}

/** Seeds a fake "repository" the provider downloads: `skills/hello/SKILL.md`. */
async function seedRepo(
  dir: string,
  options: { withSkillMd?: boolean; evil?: boolean } = {},
): Promise<void> {
  const skillDir = path.join(dir, 'skills', 'hello')
  await fs.mkdir(skillDir, { recursive: true })
  if (options.withSkillMd !== false) {
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# hello\n', 'utf8')
  }
  if (options.evil === true) {
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true })
    await fs.writeFile(
      path.join(skillDir, 'scripts', 'run.sh'),
      '#!/bin/sh\nexec("rm -rf /tmp/x")\n',
      'utf8',
    )
  }
}

class FakeGithubProvider implements RegistryProvider {
  readonly id = 'github'
  downloads = 0

  constructor(
    private readonly seedDir: string,
    private readonly revision: string,
    private readonly integrity?: string,
  ) {}

  async search(): Promise<RegistrySearchResult[]> {
    return []
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    const resolved: ResolvedSource = { source, revision: this.revision }
    if (this.integrity !== undefined) {
      resolved.integrity = this.integrity
    }
    return resolved
  }

  async download(_source: NormalizedSource, _revision: string, targetDir: string): Promise<void> {
    this.downloads++
    await fs.cp(this.seedDir, targetDir, { recursive: true })
  }

  async getLatestRevision(): Promise<string> {
    return 'latest-sha'
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

describe('installSkill', () => {
  it('records install targets so the completed install can be rolled back', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      const seed = path.join(dir, 'seed')
      await fs.mkdir(repoRoot, { recursive: true })
      await seedRepo(seed)

      await installSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        homeRoot,
        provider: new FakeGithubProvider(seed, 'abc123'),
      })

      const rollback = await createOperationRuntime({
        repositoryRoot: repoRoot,
        homeRoot,
      }).rollback()
      expect(rollback.restoredTargets).toContain(path.join(repoRoot, 'skillbox.yaml'))
      await expect(fs.stat(path.join(repoRoot, 'skillbox.yaml'))).rejects.toThrow()
      await expect(
        fs.stat(path.join(buildSkillboxHomeLayout(homeRoot).library, 'managed', 'hello')),
      ).rejects.toThrow()
    })
  })

  it('uses the injected canonical source resolver for resolve and materialize', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      const seed = path.join(dir, 'seed')
      await fs.mkdir(repoRoot, { recursive: true })
      await seedRepo(seed)

      const calls: Array<{ operation: string; source: CanonicalSkillSource }> = []
      const adapter: SkillSourceAdapter = {
        type: 'github',
        capabilities: { resolve: true, download: false, latest: true, materialize: true },
        async resolve(source) {
          calls.push({ operation: 'resolve', source })
          return { source, revision: 'resolver-sha' }
        },
        async latest(source) {
          calls.push({ operation: 'latest', source })
          return 'resolver-sha'
        },
        async materialize(source, _revision, targetDir) {
          calls.push({ operation: 'materialize', source })
          await fs.cp(seed, targetDir, { recursive: true })
        },
      }

      const result = await installSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        homeRoot,
        sourceResolver: createSkillSourceResolver({ adapters: [adapter] }),
      })

      expect(result.revision).toBe('resolver-sha')
      expect(calls).toEqual([
        {
          operation: 'resolve',
          source: { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
        },
        {
          operation: 'materialize',
          source: { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
        },
      ])
    })
  })

  it('installs a managed skill end to end (resolve → download → validate → materialize → manifest → lock → agents)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      const layout = buildSkillboxHomeLayout(homeRoot)
      const agentDir = path.join(dir, 'agents', 'claude')
      await fs.mkdir(repoRoot, { recursive: true })
      await fs.mkdir(agentDir, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed)

      const provider = new FakeGithubProvider(seed, 'abc123')
      const adapter = new FakeAgentAdapter('claude', agentDir)
      const agentRegistry = new AgentRegistry([adapter])

      const result = await installSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        provider,
        homeRoot,
        targetAgents: ['claude'],
        agentRegistry,
      })

      expect(result.alias).toBe('hello')
      expect(result.mode).toBe('managed')
      expect(result.revision).toBe('abc123')
      expect(result.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(result.cacheHit).toBe(false)
      expect(result.agents).toEqual(['claude'])
      expect(result.security.risk).toBe('low')
      expect(result.materializedPath).toBe(path.join(layout.library, 'managed', 'hello'))

      // Materialized into the managed library only — never into the repo (M15.3).
      expect(await fs.stat(path.join(result.materializedPath, 'SKILL.md'))).toBeDefined()
      await expect(fs.stat(path.join(repoRoot, 'skills'))).rejects.toThrow()

      // Manifest gains only the entry.
      const manifest = await readManifest(repoRoot)
      const entry = manifest.skills.hello
      expect(entry?.mode).toBe('managed')
      expect(entry?.source).toEqual({
        type: 'github',
        repo: 'acme/skillz',
        path: 'skills/hello',
        ref: 'main',
      })
      expect(entry?.agents).toEqual(['claude'])

      // Lockfile records revision / integrity / security / upstream.
      const lockfile = await readLockfile(repoRoot)
      const locked = lockfile.skills.hello
      expect(locked?.mode).toBe('managed')
      expect(locked?.revision).toBe('abc123')
      expect(locked?.integrity).toBe(result.integrity)
      expect(locked?.security?.risk).toBe('low')
      expect(locked?.security?.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(locked?.upstream?.baseRevision).toBe('abc123')
      expect(locked?.upstream?.source).toEqual(entry?.source)

      // Agent link created and recorded in state/links.json.
      expect(adapter.createdLinks).toEqual(['hello'])
      expect(await fs.stat(path.join(agentDir, 'hello'))).toBeDefined()
      const linksJson = await fs.readFile(layout.linksFile, 'utf8')
      expect(linksJson).toContain('"claude"')
      expect(linksJson).toContain('"hello"')

      // Verified content was cached (M15.3).
      const cache = new ManagedCache(layout.cache)
      const cached = await cache.get(GITHUB_SOURCE, 'abc123', result.integrity)
      expect(cached).not.toBeNull()

      // Temp dirs are cleaned up.
      expect((await fs.readdir(layout.tmp)).length).toBe(0)
    })
  })

  it('reuses the managed cache: a second install of the same source skips the download', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed)

      const first = await installSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        provider: new FakeGithubProvider(seed, 'abc123'),
        homeRoot,
      })
      expect(first.cacheHit).toBe(false)

      const secondProvider = new FakeGithubProvider(seed, 'abc123')
      const second = await installSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        provider: secondProvider,
        homeRoot,
        alias: 'hello-2',
      })
      expect(second.cacheHit).toBe(true)
      expect(secondProvider.downloads).toBe(0)
      expect(second.integrity).toBe(first.integrity)
      expect(second.revision).toBe('abc123')
    })
  })

  it('rejects a high-risk skill with INSTALL_SECURITY_BLOCKED and rolls everything back', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      const layout = buildSkillboxHomeLayout(homeRoot)
      await fs.mkdir(repoRoot, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed, { evil: true })

      await expect(
        installSkill(GITHUB_SOURCE, {
          repositoryRoot: repoRoot,
          provider: new FakeGithubProvider(seed, 'abc123'),
          homeRoot,
        }),
      ).rejects.toMatchObject({ code: 'INSTALL_SECURITY_BLOCKED' })

      // No half-installed state: no manifest, no lockfile, no library copy, no tmp, no cache.
      await expect(fs.stat(path.join(repoRoot, 'skillbox.yaml'))).rejects.toThrow()
      await expect(fs.stat(path.join(repoRoot, 'skillbox.lock'))).rejects.toThrow()
      await expect(fs.stat(path.join(layout.library, 'managed', 'hello'))).rejects.toThrow()
      expect((await fs.readdir(layout.tmp)).length).toBe(0)
      // The cache never gains an entry for content the security gate rejected.
      await expect(fs.stat(layout.cache)).rejects.toThrow()
    })
  })

  it('installs a high-risk skill when allowPolicy.allowHighRisk is set', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed, { evil: true })

      const result = await installSkill(GITHUB_SOURCE, {
        repositoryRoot: repoRoot,
        provider: new FakeGithubProvider(seed, 'abc123'),
        homeRoot,
        allowPolicy: { allowHighRisk: true },
      })
      expect(result.security.risk).toBe('high')

      const lockfile = await readLockfile(repoRoot)
      expect(lockfile.skills.hello?.security?.risk).toBe('high')
    })
  })

  it('fails with INTEGRITY_MISMATCH when the download does not match the source integrity (M15.5)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed)

      await expect(
        installSkill(GITHUB_SOURCE, {
          repositoryRoot: repoRoot,
          provider: new FakeGithubProvider(seed, 'abc123', `sha256:${'0'.repeat(64)}`),
          homeRoot,
        }),
      ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })

      await expect(fs.stat(path.join(repoRoot, 'skillbox.yaml'))).rejects.toThrow()
      await expect(fs.stat(path.join(repoRoot, 'skillbox.lock'))).rejects.toThrow()
    })
  })

  it('rejects a source path that escapes the download (path traversal)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed)

      await expect(
        installSkill(GITHUB_PATH_TRAVERSAL, {
          repositoryRoot: repoRoot,
          provider: new FakeGithubProvider(seed, 'abc123'),
          homeRoot,
        }),
      ).rejects.toMatchObject({ code: 'INSTALL_INVALID_PATH' })
    })
  })

  it('rejects a skill without SKILL.md (structure validation)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed, { withSkillMd: false })

      await expect(
        installSkill(GITHUB_SOURCE, {
          repositoryRoot: repoRoot,
          provider: new FakeGithubProvider(seed, 'abc123'),
          homeRoot,
        }),
      ).rejects.toMatchObject({ code: 'INSTALL_INVALID_STRUCTURE' })
    })
  })

  it('rolls back the manifest and lockfile when the agents step fails', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      const layout = buildSkillboxHomeLayout(homeRoot)
      await fs.mkdir(repoRoot, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed)

      await expect(
        installSkill(GITHUB_SOURCE, {
          repositoryRoot: repoRoot,
          provider: new FakeGithubProvider(seed, 'abc123'),
          homeRoot,
          targetAgents: ['ghost'],
        }),
      ).rejects.toMatchObject({ code: 'INSTALL_AGENT_LINK_FAILED' })

      // Nothing left behind: repo files absent, no library copy, tmp clean.
      await expect(fs.stat(path.join(repoRoot, 'skillbox.yaml'))).rejects.toThrow()
      await expect(fs.stat(path.join(repoRoot, 'skillbox.lock'))).rejects.toThrow()
      await expect(fs.stat(path.join(layout.library, 'managed', 'hello'))).rejects.toThrow()
      expect((await fs.readdir(layout.tmp)).length).toBe(0)
    })
  })

  it('restores a pre-existing manifest on rollback', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })
      await writeManifest(
        repoRoot,
        addSkill(emptyManifest(), 'other', {
          source: { type: 'github', repo: 'acme/other', path: 'skills/other' },
          agents: [],
        }),
      )

      const seed = path.join(dir, 'seed')
      await seedRepo(seed)

      await expect(
        installSkill(GITHUB_SOURCE, {
          repositoryRoot: repoRoot,
          provider: new FakeGithubProvider(seed, 'abc123'),
          homeRoot,
          targetAgents: ['ghost'],
        }),
      ).rejects.toMatchObject({ code: 'INSTALL_AGENT_LINK_FAILED' })

      const manifest = await readManifest(repoRoot)
      expect(manifest.skills.other).toBeDefined()
      expect(manifest.skills.hello).toBeUndefined()
    })
  })

  it('removes a created agent link when a later agent link fails (rollback of step 10)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })
      const agentDir = path.join(dir, 'agents', 'claude')
      await fs.mkdir(agentDir, { recursive: true })

      const seed = path.join(dir, 'seed')
      await seedRepo(seed)
      const adapter = new FakeAgentAdapter('claude', agentDir)

      await expect(
        installSkill(GITHUB_SOURCE, {
          repositoryRoot: repoRoot,
          provider: new FakeGithubProvider(seed, 'abc123'),
          homeRoot,
          targetAgents: ['claude', 'ghost'],
          agentRegistry: new AgentRegistry([adapter]),
        }),
      ).rejects.toMatchObject({ code: 'INSTALL_AGENT_LINK_FAILED' })

      expect(adapter.createdLinks).toEqual(['hello'])
      expect(adapter.removedLinks).toEqual(['hello'])
      await expect(fs.stat(path.join(agentDir, 'hello'))).rejects.toThrow()
      await expect(fs.stat(path.join(repoRoot, 'skillbox.yaml'))).rejects.toThrow()
    })
  })

  it('refuses to install an alias that already exists in the manifest (INSTALL_CONFLICT)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })
      await writeManifest(
        repoRoot,
        addSkill(emptyManifest(), 'hello', {
          source: { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
          agents: [],
        }),
      )

      const seed = path.join(dir, 'seed')
      await seedRepo(seed)

      await expect(
        installSkill(GITHUB_SOURCE, {
          repositoryRoot: repoRoot,
          provider: new FakeGithubProvider(seed, 'abc123'),
          homeRoot,
        }),
      ).rejects.toMatchObject({ code: 'INSTALL_CONFLICT' })
    })
  })

  it('fails with INSTALL_SOURCE_UNRESOLVED when no provider is wired', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot, { recursive: true })

      await expect(
        installSkill(GITHUB_SOURCE, { repositoryRoot: repoRoot, homeRoot }),
      ).rejects.toMatchObject({ code: 'INSTALL_SOURCE_UNRESOLVED' })
    })
  })

  it('rejects local sources (they use the import flow)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot, { recursive: true })

      await expect(
        installSkill(
          { type: 'local', path: path.join(dir, 'some-skill') },
          {
            repositoryRoot: repoRoot,
          },
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' })
    })
  })

  it('derives a valid alias from the source', () => {
    expect(defaultAliasFor(GITHUB_SOURCE)).toBe('hello')
    expect(defaultAliasFor({ type: 'github', repo: 'acme/skillz' })).toBe('skillz')
    expect(defaultAliasFor({ type: 'skills-sh', package: 'acme/react-best-practices' })).toBe(
      'react-best-practices',
    )
  })
})
