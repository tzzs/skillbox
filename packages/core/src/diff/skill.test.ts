import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { writeManifest, emptyManifest, addSkill } from '../manifest/index.js'
import { writeLockfile, emptyLockfile, createLockedSkill } from '../lockfile/index.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { ProviderRegistry } from '../registry/registry.js'
import type {
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
} from '../registry/types.js'
import { diffSkill } from './skill.js'
import { createSkillSourceResolver, type SkillSourceAdapter } from '../sources/index.js'

/**
 * Provider that serves per-revision fixture directories: `download` copies the
 * fixture for the requested revision into the target dir, and the "latest"
 * revision is whatever the test says it is.
 */
class FakeGithubProvider implements RegistryProvider {
  readonly id = 'github'

  constructor(
    private readonly revisions: Map<string, string>,
    private readonly latestRevision: string,
  ) {}

  search(_query: string): Promise<RegistrySearchResult[]> {
    return Promise.resolve([])
  }

  resolve(source: NormalizedSource): Promise<ResolvedSource> {
    return Promise.resolve({ source, revision: this.latestRevision })
  }

  async download(_source: NormalizedSource, revision: string, targetDir: string): Promise<void> {
    const fixture = this.revisions.get(revision)
    if (fixture === undefined) {
      throw new Error(`unknown revision ${revision}`)
    }
    await fs.cp(fixture, targetDir, { recursive: true })
  }

  getLatestRevision(_source: NormalizedSource): Promise<string> {
    return Promise.resolve(this.latestRevision)
  }
}

function registryWith(provider: FakeGithubProvider): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.registerProvider(provider)
  return registry
}

async function writeFileRecursive(dir: string, relative: string, content: string): Promise<void> {
  const target = path.join(dir, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

describe('diffSkill', () => {
  it('resolves upstream revisions through an injected canonical source resolver', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      const localDir = path.join(repoRoot, 'skills', 'foo')
      const baseFixture = path.join(dir, 'fixtures', 'rev1')
      const latestFixture = path.join(dir, 'fixtures', 'rev2')
      await fs.mkdir(repoRoot)
      await writeFileRecursive(localDir, 'SKILL.md', '# Foo (local)\n')
      await writeFileRecursive(baseFixture, 'SKILL.md', '# Foo\n')
      await writeFileRecursive(latestFixture, 'SKILL.md', '# Foo (latest)\n')

      const source = { type: 'local' as const, path: 'skills/foo' }
      await writeManifest(
        repoRoot,
        addSkill(emptyManifest(), 'foo', {
          source,
          mode: 'forked',
          upstream: { type: 'github', repo: 'acme/foo' },
        }),
      )
      const lockfile = emptyLockfile()
      const locked = createLockedSkill({
        mode: 'forked',
        source,
        integrity: await computeSkillIntegrity(localDir),
      })
      locked.upstream = {
        source: { type: 'github', repo: 'acme/foo' },
        baseRevision: 'rev1',
        latestRevision: 'rev2',
      }
      lockfile.skills.foo = locked
      await writeLockfile(repoRoot, lockfile)

      const fixtures = new Map([
        ['rev1', baseFixture],
        ['rev2', latestFixture],
      ])
      const adapter: SkillSourceAdapter = {
        type: 'github',
        capabilities: { resolve: false, download: false, latest: true, materialize: true },
        latest: async () => 'rev2',
        materialize: async (_source, revision, targetDir) => {
          const fixture = fixtures.get(revision)
          if (fixture === undefined) throw new Error(`unknown revision ${revision}`)
          await fs.cp(fixture, targetDir, { recursive: true })
        },
      }

      const result = await diffSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        sourceResolver: createSkillSourceResolver({ adapters: [adapter] }),
      })

      expect(result.views.map((view) => view.label)).toEqual([
        'Base vs Local',
        'Local vs Latest',
        'Base vs Latest',
      ])
      expect(result.unchanged).toBe(false)
    })
  })

  it('produces the three forked views Base/Local/Latest', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const localDir = path.join(repoRoot, 'skills', 'foo')
      await writeFileRecursive(localDir, 'SKILL.md', '# Foo (local edit)\n')
      await writeFileRecursive(localDir, 'notes.md', 'local notes\n')

      const baseFixture = path.join(dir, 'fixtures', 'rev1')
      await writeFileRecursive(baseFixture, 'SKILL.md', '# Foo\n')
      const upstreamFixture = path.join(dir, 'fixtures', 'rev2')
      await writeFileRecursive(upstreamFixture, 'SKILL.md', '# Foo (upstream)\n')
      await writeFileRecursive(upstreamFixture, 'README.md', 'upstream readme\n')

      const source = { type: 'local' as const, path: 'skills/foo' }
      const manifest = addSkill(emptyManifest(), 'foo', {
        source,
        mode: 'forked',
        upstream: { type: 'github', repo: 'acme/foo' },
      })
      await writeManifest(repoRoot, manifest)

      const lockfile = emptyLockfile()
      const locked = createLockedSkill({
        mode: 'forked',
        source,
        integrity: await computeSkillIntegrity(localDir),
      })
      locked.upstream = {
        source: { type: 'github', repo: 'acme/foo' },
        baseRevision: 'rev1',
        latestRevision: 'rev2',
      }
      lockfile.skills.foo = locked
      await writeLockfile(repoRoot, lockfile)

      const provider = new FakeGithubProvider(
        new Map([
          ['rev1', baseFixture],
          ['rev2', upstreamFixture],
        ]),
        'rev2',
      )
      const diff = await diffSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot: path.join(dir, 'home'),
        registry: registryWith(provider),
      })

      expect(diff.name).toBe('foo')
      expect(diff.mode).toBe('forked')
      expect(diff.unchanged).toBe(false)
      expect(diff.views.map((view) => view.label)).toEqual([
        'Base vs Local',
        'Local vs Latest',
        'Base vs Latest',
      ])

      const [baseLocal, localLatest, baseLatest] = diff.views
      // Base vs Local: SKILL.md and notes.md modified locally.
      expect(baseLocal?.files.map((file) => file.path)).toEqual(['SKILL.md', 'notes.md'])
      expect(baseLocal?.files[0]?.status).toBe('modified')
      expect(baseLocal?.files[0]?.patch).toContain('+# Foo (local edit)')
      // Local vs Latest: local notes edit vs upstream notes + README.
      const localLatestPaths = localLatest?.files.map((file) => file.path).sort()
      expect(localLatestPaths).toEqual(['README.md', 'SKILL.md', 'notes.md'])
      // Base vs Latest: upstream changes only.
      expect(baseLatest?.files.map((file) => file.path).sort()).toEqual(['README.md', 'SKILL.md'])
    })
  })

  it('supports narrowing a forked diff to one view via `which`', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const localDir = path.join(repoRoot, 'skills', 'foo')
      await writeFileRecursive(localDir, 'SKILL.md', '# Foo (local edit)\n')

      const baseFixture = path.join(dir, 'fixtures', 'rev1')
      await writeFileRecursive(baseFixture, 'SKILL.md', '# Foo\n')
      const upstreamFixture = path.join(dir, 'fixtures', 'rev2')
      await writeFileRecursive(upstreamFixture, 'SKILL.md', '# Foo (upstream)\n')

      const source = { type: 'local' as const, path: 'skills/foo' }
      const manifest = addSkill(emptyManifest(), 'foo', {
        source,
        mode: 'forked',
        upstream: { type: 'github', repo: 'acme/foo' },
      })
      await writeManifest(repoRoot, manifest)
      const lockfile = emptyLockfile()
      const locked = createLockedSkill({
        mode: 'forked',
        source,
        integrity: await computeSkillIntegrity(localDir),
      })
      locked.upstream = {
        source: { type: 'github', repo: 'acme/foo' },
        baseRevision: 'rev1',
        latestRevision: 'rev2',
      }
      lockfile.skills.foo = locked
      await writeLockfile(repoRoot, lockfile)

      const provider = new FakeGithubProvider(
        new Map([
          ['rev1', baseFixture],
          ['rev2', upstreamFixture],
        ]),
        'rev2',
      )
      const diff = await diffSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot: path.join(dir, 'home'),
        registry: registryWith(provider),
        which: 'base-upstream',
      })
      expect(diff.views.map((view) => view.label)).toEqual(['Base vs Latest'])
    })
  })

  it('produces one Current vs Latest view for a managed skill', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)

      const rev1 = path.join(dir, 'fixtures', 'rev1')
      await writeFileRecursive(rev1, 'SKILL.md', '# Foo v1\n')
      const rev2 = path.join(dir, 'fixtures', 'rev2')
      await writeFileRecursive(rev2, 'SKILL.md', '# Foo v2\n')

      const source = { type: 'github' as const, repo: 'acme/foo', ref: 'main' }
      const manifest = addSkill(emptyManifest(), 'foo', { source })
      await writeManifest(repoRoot, manifest)
      const lockfile = emptyLockfile()
      const locked = createLockedSkill({
        mode: 'managed',
        source,
        integrity: `sha256:${'a'.repeat(64)}`,
      })
      locked.revision = 'rev1'
      locked.upstream = {
        source,
        baseRevision: 'rev1',
        latestRevision: 'rev2',
      }
      lockfile.skills.foo = locked
      await writeLockfile(repoRoot, lockfile)

      const provider = new FakeGithubProvider(
        new Map([
          ['rev1', rev1],
          ['rev2', rev2],
        ]),
        'rev2',
      )
      const diff = await diffSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot: path.join(dir, 'home'),
        registry: registryWith(provider),
      })
      expect(diff.mode).toBe('managed')
      expect(diff.views.map((view) => view.label)).toEqual(['Current vs Latest'])
      expect(diff.views[0]?.files[0]?.status).toBe('modified')
      expect(diff.views[0]?.files[0]?.patch).toContain('+# Foo v2')
    })
  })

  it('marks binary files instead of rendering their content', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const localDir = path.join(repoRoot, 'skills', 'foo')
      await writeFileRecursive(localDir, 'SKILL.md', '# Foo\n')

      const baseFixture = path.join(dir, 'fixtures', 'rev1')
      await writeFileRecursive(baseFixture, 'SKILL.md', '# Foo\n')
      const upstreamFixture = path.join(dir, 'fixtures', 'rev2')
      await writeFileRecursive(upstreamFixture, 'SKILL.md', '# Foo\n')
      await fs.writeFile(
        path.join(upstreamFixture, 'logo.png'),
        Buffer.from([0x89, 0x50, 0x00, 0x0a]),
      )

      const source = { type: 'local' as const, path: 'skills/foo' }
      const manifest = addSkill(emptyManifest(), 'foo', {
        source,
        mode: 'forked',
        upstream: { type: 'github', repo: 'acme/foo' },
      })
      await writeManifest(repoRoot, manifest)
      const lockfile = emptyLockfile()
      const locked = createLockedSkill({
        mode: 'forked',
        source,
        integrity: await computeSkillIntegrity(localDir),
      })
      locked.upstream = {
        source: { type: 'github', repo: 'acme/foo' },
        baseRevision: 'rev1',
        latestRevision: 'rev2',
      }
      lockfile.skills.foo = locked
      await writeLockfile(repoRoot, lockfile)

      const provider = new FakeGithubProvider(
        new Map([
          ['rev1', baseFixture],
          ['rev2', upstreamFixture],
        ]),
        'rev2',
      )
      const diff = await diffSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot: path.join(dir, 'home'),
        registry: registryWith(provider),
        which: 'base-upstream',
      })
      const logo = diff.views[0]?.files.find((file) => file.path === 'logo.png')
      expect(logo?.status).toBe('added')
      expect(logo?.binary).toBe(true)
      expect(logo?.patch).toBe('')
    })
  })
})
