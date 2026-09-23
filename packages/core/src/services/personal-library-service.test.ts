import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import {
  AgentRegistry,
  type AgentAdapter,
  type AgentLinkOptions,
  type AgentUnlinkResult,
} from '../agent/index.js'
import type {
  AgentCapabilities,
  AgentDetectionResult,
  AgentInstalledSkill,
} from '../domain/index.js'
import { readManifest } from '../manifest/index.js'
import { PersonalLibraryService } from './personal-library-service.js'

const CAPS: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

/**
 * Hermetic adapter: serves skills from a fixture directory and creates real
 * directory symlinks when Skillbox links into it, so migrateAgents flows can
 * be exercised end-to-end without any agent binary on the machine.
 */
class FakeAgent implements AgentAdapter {
  readonly id: string
  readonly name: string
  readonly capabilities = CAPS

  constructor(
    private readonly skillsDir: string,
    id = 'fake-a',
    name = 'Fake A',
  ) {
    this.id = id
    this.name = name
  }

  async detect(): Promise<AgentDetectionResult> {
    return { detected: true, skillDirectories: [this.skillsDir], confidence: 'high' }
  }

  async getSkillDirectories(): Promise<string[]> {
    return [this.skillsDir]
  }

  /** Returns every directory as an unmanaged skill — the service filters. */
  async scanSkills(): Promise<AgentInstalledSkill[]> {
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true })
    const out: AgentInstalledSkill[] = []
    for (const entry of entries) {
      const full = path.join(this.skillsDir, entry.name)
      let stats
      try {
        stats = await fs.stat(full)
      } catch {
        continue // broken link
      }
      if (!stats.isDirectory()) {
        continue
      }
      // Mirrors the real CLI adapters: symlinked entries are followed, and a
      // symlink here means Skillbox created it, so it reports as managed.
      out.push({ name: entry.name, path: full, managedBySkillbox: entry.isSymbolicLink() })
    }
    return out
  }

  async linkSkill(source: string, options?: AgentLinkOptions): Promise<void> {
    const name = options?.name ?? path.basename(source)
    await fs.symlink(source, path.join(this.skillsDir, name), 'dir')
  }

  async unlinkSkill(name: string): Promise<AgentUnlinkResult> {
    const target = path.join(this.skillsDir, name)
    try {
      await fs.unlink(target)
      return { name, path: target, removed: true, reason: 'managed' }
    } catch {
      return { name, path: target, removed: false, reason: 'not_found' }
    }
  }
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `# ${name}\n\n${body}\n`, 'utf8')
}

describe('PersonalLibraryService', () => {
  it('creates the personal repository and adopts detected agent skills', async () => {
    await withTempDir(async (dir) => {
      const homeRoot = path.join(dir, 'home')
      const agentA = path.join(dir, 'agents', 'a', 'skills')
      const agentB = path.join(dir, 'agents', 'b', 'skills')
      await fs.mkdir(agentA, { recursive: true })
      await fs.mkdir(agentB, { recursive: true })
      await writeSkill(agentA, 'valid-one', 'one')
      await writeSkill(agentA, 'valid-shared', 'shared')
      await fs.mkdir(path.join(agentA, '.system'), { recursive: true }) // no SKILL.md
      await writeSkill(agentB, 'valid-shared', 'shared')
      await writeSkill(agentB, 'valid-two', 'two')

      const registry = new AgentRegistry([
        new FakeAgent(agentA, 'fake-a', 'Fake A'),
        new FakeAgent(agentB, 'fake-b', 'Fake B'),
      ])
      const service = new PersonalLibraryService({ homeRoot, registry })

      expect(await service.isEmpty()).toBe(true)
      const root = await service.ensureLibrary()
      expect(root).toBe(path.join(homeRoot, 'personal'))
      expect((await fs.stat(path.join(root, 'skillbox.yaml'))).isFile()).toBe(true)

      const report = await service.adopt()
      expect(report).toMatchObject({ scanned: 3, imported: 3, unchanged: 0, conflicts: 0 })
      expect(report.skipped).toEqual([])

      const manifest = await readManifest(root)
      expect(Object.keys(manifest.skills).sort()).toEqual([
        'valid-one',
        'valid-shared',
        'valid-two',
      ])
      // both agents holding the shared skill are recorded as its agents
      expect(manifest.skills['valid-shared']?.agents?.slice().sort()).toEqual(['fake-a', 'fake-b'])
      // agent entries became managed links into the runtime library
      const linkA = await fs.lstat(path.join(agentA, 'valid-shared'))
      expect(linkA.isSymbolicLink()).toBe(true)
      expect(path.basename(await fs.realpath(path.join(agentA, 'valid-shared')))).toBe(
        'valid-shared',
      )
      // the invalid directory was filtered: untouched, not linked, not declared
      expect((await fs.lstat(path.join(agentA, '.system'))).isSymbolicLink()).toBe(false)
      expect(await service.isEmpty()).toBe(false)
    })
  })

  it('is idempotent — managed links are skipped and only new unmanaged copies import', async () => {
    await withTempDir(async (dir) => {
      const homeRoot = path.join(dir, 'home')
      const agentA = path.join(dir, 'agents', 'a', 'skills')
      await fs.mkdir(agentA, { recursive: true })
      await writeSkill(agentA, 'valid-one', 'one')

      const registry = new AgentRegistry([new FakeAgent(agentA, 'fake-a', 'Fake A')])
      const service = new PersonalLibraryService({ homeRoot, registry })
      await service.ensureLibrary()
      const first = await service.adopt()
      expect(first.imported).toBe(1)

      // second adopt: the migrated entry is now a managed link — nothing to do
      const second = await service.adopt()
      expect(second).toMatchObject({ scanned: 0, imported: 0, unchanged: 0, conflicts: 0 })

      // a new agent appears holding an identical unmanaged copy → unchanged
      const agentB = path.join(dir, 'agents', 'b', 'skills')
      await fs.mkdir(agentB, { recursive: true })
      await writeSkill(agentB, 'valid-one', 'one')
      registry.register(new FakeAgent(agentB, 'fake-b', 'Fake B'))
      const third = await service.adopt()
      expect(third).toMatchObject({ scanned: 1, imported: 0, unchanged: 1, conflicts: 0 })
      // `unchanged` leaves the identical external copy untouched — no migration
      expect((await fs.lstat(path.join(agentB, 'valid-one'))).isSymbolicLink()).toBe(false)
    })
  })

  it('reports a conflict instead of overwriting diverged personal copies', async () => {
    await withTempDir(async (dir) => {
      const homeRoot = path.join(dir, 'home')
      const agentA = path.join(dir, 'agents', 'a', 'skills')
      await fs.mkdir(agentA, { recursive: true })
      await writeSkill(agentA, 'valid-one', 'one')

      const registry = new AgentRegistry([new FakeAgent(agentA, 'fake-a', 'Fake A')])
      const service = new PersonalLibraryService({
        homeRoot,
        registry,
      })
      await service.ensureLibrary()
      await service.adopt()

      // a second agent later shows up with a DIFFERENT copy of the same skill
      const agentB = path.join(dir, 'agents', 'b', 'skills')
      await fs.mkdir(agentB, { recursive: true })
      await writeSkill(agentB, 'valid-one', 'divergent external copy')
      registry.register(new FakeAgent(agentB, 'fake-b', 'Fake B'))

      const report = await service.adopt()
      expect(report.conflicts).toBe(1)
      expect(report.skipped).toEqual([
        {
          name: 'valid-one',
          agents: ['fake-b'],
          reason: 'existing skill with different content',
        },
      ])
      // the personal copy is untouched, and the divergent external stays a
      // real directory (never replaced by a link on conflict)
      const repoCopy = path.join(service.root(), 'skills', 'valid-one', 'SKILL.md')
      expect(await fs.readFile(repoCopy, 'utf8')).toContain('# valid-one')
      expect((await fs.lstat(path.join(agentB, 'valid-one'))).isSymbolicLink()).toBe(false)
    })
  })

  it('leaves ignored skills and agents alone and reports why', async () => {
    await withTempDir(async (dir) => {
      const homeRoot = path.join(dir, 'home')
      const agentA = path.join(dir, 'agents', 'a', 'skills')
      const agentB = path.join(dir, 'agents', 'b', 'skills')
      await fs.mkdir(agentA, { recursive: true })
      await fs.mkdir(agentB, { recursive: true })
      await writeSkill(agentA, 'keep-me', 'keep')
      await writeSkill(agentA, 'skip-by-name', 'skip')
      await writeSkill(agentA, 'shared-owner', 'shared')
      await writeSkill(agentB, 'shared-owner', 'shared')
      await writeSkill(agentB, 'only-in-b', 'b only')

      const registry = new AgentRegistry([
        new FakeAgent(agentA, 'fake-a', 'Fake A'),
        new FakeAgent(agentB, 'fake-b', 'Fake B'),
      ])
      const service = new PersonalLibraryService({ homeRoot, registry })

      // Entries are matched trimmed and case-insensitively, so a hand-typed
      // config value behaves like the CLI flag.
      const report = await service.adopt({
        ignoreAgents: ['  FAKE-B '],
        ignoreSkills: ['skip-by-name'],
      })

      expect(report).toMatchObject({ scanned: 4, imported: 2 })
      expect(report.skipped).toEqual([
        { name: 'only-in-b', agents: ['fake-b'], reason: 'every owning agent is ignored' },
        { name: 'skip-by-name', agents: ['fake-a'], reason: 'ignored by settings' },
      ])

      const manifest = await readManifest(service.root())
      expect(Object.keys(manifest.skills).sort()).toEqual(['keep-me', 'shared-owner'])
      // the shared skill is still adopted for the non-ignored agent, and only
      // for that agent
      expect(manifest.skills['shared-owner']?.agents).toEqual(['fake-a'])
      expect((await fs.lstat(path.join(agentB, 'only-in-b'))).isSymbolicLink()).toBe(false)
      expect((await fs.lstat(path.join(agentA, 'skip-by-name'))).isSymbolicLink()).toBe(false)
    })
  })
})
