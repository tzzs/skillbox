import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { writeManifest, emptyManifest, addSkill } from '../manifest/index.js'
import { readLockfile, writeLockfile, emptyLockfile, createLockedSkill } from '../lockfile/index.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { ProviderRegistry } from '../registry/registry.js'
import type {
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
} from '../registry/types.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import { mergeSkill, continueMerge, abortMerge } from './merge-skill.js'
import { mergeStatePaths, hasPendingMerge } from './state.js'
import { containsConflictMarkers } from './merge.js'
import { createSkillSourceResolver, type SkillSourceAdapter } from '../sources/index.js'

/** Serves per-revision fixture directories over the github provider id. */
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

async function writeFileRecursive(dir: string, relative: string, content: string): Promise<void> {
  const target = path.join(dir, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

async function readFileText(dir: string, relative: string): Promise<string> {
  return fs.readFile(path.join(dir, relative), 'utf8')
}

const UPSTREAM_SOURCE = { type: 'github' as const, repo: 'acme/foo' }
const LOCAL_SOURCE = { type: 'local' as const, path: 'skills/foo' }

interface ForkedFixture {
  dir: string
  repoRoot: string
  homeRoot: string
  localDir: string
  provider: FakeGithubProvider
}

/** Repo with a forked skill whose base (rev1) and latest (rev2) are fixtures. */
async function seedForkedSkill(
  dir: string,
  options: { conflict?: boolean } = {},
): Promise<ForkedFixture> {
  const repoRoot = path.join(dir, 'repo')
  const homeRoot = path.join(dir, 'home')
  await fs.mkdir(repoRoot)
  const localDir = path.join(repoRoot, 'skills', 'foo')

  const baseFixture = path.join(dir, 'fixtures', 'rev1')
  await writeFileRecursive(baseFixture, 'SKILL.md', '# Foo\nshared line\n')
  await writeFileRecursive(baseFixture, 'notes.md', 'base notes\n')
  await writeFileRecursive(baseFixture, 'README.md', 'base readme\n')
  const upstreamFixture = path.join(dir, 'fixtures', 'rev2')
  await writeFileRecursive(upstreamFixture, 'SKILL.md', '# Foo\nshared line\n')
  await writeFileRecursive(upstreamFixture, 'notes.md', 'base notes\n')
  await writeFileRecursive(upstreamFixture, 'README.md', 'upstream readme\n')

  if (options.conflict === true) {
    // The same line changed on both sides → guaranteed conflict; the other
    // files stay identical to base so SKILL.md is the only conflict.
    await writeFileRecursive(localDir, 'SKILL.md', '# Foo\nlocal line\n')
    await writeFileRecursive(localDir, 'notes.md', 'base notes\n')
    await writeFileRecursive(localDir, 'README.md', 'base readme\n')
    await writeFileRecursive(upstreamFixture, 'SKILL.md', '# Foo\nupstream line\n')
  } else {
    // Disjoint changes: local edits notes.md, upstream edits README.md.
    await writeFileRecursive(localDir, 'SKILL.md', '# Foo\nshared line\n')
    await writeFileRecursive(localDir, 'notes.md', 'local notes\n')
    await writeFileRecursive(localDir, 'README.md', 'base readme\n')
  }

  const manifest = addSkill(emptyManifest(), 'foo', {
    source: LOCAL_SOURCE,
    mode: 'forked',
    upstream: UPSTREAM_SOURCE,
  })
  await writeManifest(repoRoot, manifest)

  const lockfile = emptyLockfile()
  const locked = createLockedSkill({
    mode: 'forked',
    source: LOCAL_SOURCE,
    integrity: await computeSkillIntegrity(localDir),
  })
  locked.upstream = { source: UPSTREAM_SOURCE, baseRevision: 'rev1', latestRevision: 'rev2' }
  lockfile.skills.foo = locked
  await writeLockfile(repoRoot, lockfile)

  const provider = new FakeGithubProvider(
    new Map([
      ['rev1', baseFixture],
      ['rev2', upstreamFixture],
    ]),
    'rev2',
  )
  return { dir, repoRoot, homeRoot, localDir, provider }
}

function registryWith(provider: FakeGithubProvider): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.registerProvider(provider)
  return registry
}

async function mergedLocked(repoRoot: string) {
  return (await readLockfile(repoRoot)).skills.foo
}

describe('mergeSkill — clean merge', () => {
  it('materializes base and latest revisions through an injected canonical source resolver', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot, localDir, provider } = await seedForkedSkill(dir)
      const adapter: SkillSourceAdapter = {
        type: 'github',
        capabilities: { resolve: false, download: false, latest: true, materialize: true },
        latest: async () => 'rev2',
        materialize: async (_source, revision, targetDir) => {
          await provider.download({ type: 'github', repo: 'acme/foo' }, revision, targetDir)
        },
      }

      const result = await mergeSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        sourceResolver: createSkillSourceResolver({ adapters: [adapter] }),
      })

      expect(result.conflicts).toEqual([])
      expect(await readFileText(localDir, 'README.md')).toBe('upstream readme\n')
    })
  })

  it('merges disjoint changes and advances the lockfile metadata', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot, localDir, provider } = await seedForkedSkill(dir)

      const result = await mergeSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })

      expect(result.conflicts).toEqual([])
      expect(result.changes).toBe(0)
      expect(result.baseRevision).toBe('rev2')
      expect(result.filesMerged).toBe(2) // notes.md (local) + README.md (upstream)

      // Merged content on disk.
      expect(await readFileText(localDir, 'notes.md')).toBe('local notes\n')
      expect(await readFileText(localDir, 'README.md')).toBe('upstream readme\n')

      // Lockfile advanced: rev2 is the new base, integrity snapshots refreshed.
      const locked = await mergedLocked(repoRoot)
      expect(locked?.upstream?.baseRevision).toBe('rev2')
      expect(locked?.upstream?.latestRevision).toBe('rev2')
      expect(locked?.upstream?.baseIntegrity).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(locked?.integrity).toBe(await computeSkillIntegrity(localDir))
      expect(locked?.mode).toBe('forked')

      // No merge state left behind; a pre-merge backup was created.
      expect(await hasPendingMerge(homeRoot, 'foo')).toBe(false)
      const backups = await fs.readdir(path.join(homeRoot, 'backups'))
      expect(backups).toHaveLength(1)
      expect(backups[0]).toMatch(/^foo-/)
    })
  })
})

describe('mergeSkill — conflicted merge', () => {
  it('persists merge state and leaves markers without touching the lockfile', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot, localDir, provider } = await seedForkedSkill(dir, {
        conflict: true,
      })

      const result = await mergeSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })

      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]).toEqual({ path: 'SKILL.md', hunks: 1 })
      expect(result.baseRevision).toBeUndefined()
      expect(result.changes).toBe(1)

      // The on-disk file carries conflict markers.
      expect(containsConflictMarkers(await readFileText(localDir, 'SKILL.md'))).toBe(true)

      // Merge state persisted with pre-merge snapshots.
      const statePaths = mergeStatePaths(homeRoot, 'foo')
      expect(await hasPendingMerge(homeRoot, 'foo')).toBe(true)
      expect(await readFileText(statePaths.localDir, 'SKILL.md')).toBe('# Foo\nlocal line\n')
      expect(await readFileText(statePaths.baseDir, 'SKILL.md')).toBe('# Foo\nshared line\n')
      expect(await readFileText(statePaths.upstreamDir, 'SKILL.md')).toBe('# Foo\nupstream line\n')
      const stateFile = JSON.parse(await fs.readFile(statePaths.stateFile, 'utf8')) as {
        alias: string
        mode: string
        baseRevision: string
        latestRevision: string
        conflictFiles: Array<{ path: string; hunks: number }>
      }
      expect(stateFile.alias).toBe('foo')
      expect(stateFile.mode).toBe('forked')
      expect(stateFile.baseRevision).toBe('rev1')
      expect(stateFile.latestRevision).toBe('rev2')
      expect(stateFile.conflictFiles).toEqual([{ path: 'SKILL.md', hunks: 1 }])

      // Lockfile untouched while conflicts remain.
      const locked = await mergedLocked(repoRoot)
      expect(locked?.upstream?.baseRevision).toBe('rev1')
      expect(locked?.integrity).not.toBe(await computeSkillIntegrity(localDir))
    })
  })

  it('refuses a second merge while one is in progress', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot, provider } = await seedForkedSkill(dir, { conflict: true })
      await mergeSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })

      let caught: unknown
      try {
        await mergeSkill('foo', {
          repositoryRoot: repoRoot,
          homeRoot,
          registry: registryWith(provider),
        })
      } catch (error) {
        caught = error
      }
      expect(isSkillboxError(caught)).toBe(true)
      expect(caught).toMatchObject({ code: ErrorCode.MERGE_ALREADY_IN_PROGRESS })
    })
  })
})

describe('continueMerge', () => {
  it('reports remaining conflicts while markers exist', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot, provider } = await seedForkedSkill(dir, { conflict: true })
      await mergeSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })

      const result = await continueMerge('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })
      expect(result.resolved).toBe(false)
      expect(result.remainingConflicts).toEqual([{ path: 'SKILL.md', hunks: 1 }])

      // Lockfile still untouched.
      expect((await mergedLocked(repoRoot))?.upstream?.baseRevision).toBe('rev1')
    })
  })

  it('completes the metadata update once every marker is gone', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot, localDir, provider } = await seedForkedSkill(dir, {
        conflict: true,
      })
      await mergeSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })

      // The user resolves the conflict by picking the upstream line.
      await writeFileRecursive(localDir, 'SKILL.md', '# Foo\nresolved line\n')

      const result = await continueMerge('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })
      expect(result.resolved).toBe(true)
      expect(result.remainingConflicts).toEqual([])
      expect(result.baseRevision).toBe('rev2')

      const locked = await mergedLocked(repoRoot)
      expect(locked?.upstream?.baseRevision).toBe('rev2')
      expect(locked?.upstream?.latestRevision).toBe('rev2')
      expect(locked?.upstream?.baseIntegrity).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(locked?.integrity).toBe(await computeSkillIntegrity(localDir))

      expect(await hasPendingMerge(homeRoot, 'foo')).toBe(false)
    })
  })

  it('throws MERGE_NOT_IN_PROGRESS without a pending merge', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot } = await seedForkedSkill(dir)
      let caught: unknown
      try {
        await continueMerge('foo', { repositoryRoot: repoRoot, homeRoot })
      } catch (error) {
        caught = error
      }
      expect(isSkillboxError(caught)).toBe(true)
      expect(caught).toMatchObject({ code: ErrorCode.MERGE_NOT_IN_PROGRESS })
    })
  })
})

describe('abortMerge', () => {
  it('restores the pre-merge content and clears the state', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot, localDir, provider } = await seedForkedSkill(dir, {
        conflict: true,
      })
      await mergeSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })
      expect(containsConflictMarkers(await readFileText(localDir, 'SKILL.md'))).toBe(true)

      const result = await abortMerge('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })
      expect(result.name).toBe('foo')
      expect(result.filesRestored).toBe(3)

      expect(await readFileText(localDir, 'SKILL.md')).toBe('# Foo\nlocal line\n')
      expect(await hasPendingMerge(homeRoot, 'foo')).toBe(false)

      // Lockfile never advanced.
      expect((await mergedLocked(repoRoot))?.upstream?.baseRevision).toBe('rev1')
    })
  })

  it('throws MERGE_NOT_IN_PROGRESS without a pending merge', async () => {
    await withTempDir(async (dir) => {
      const { repoRoot, homeRoot } = await seedForkedSkill(dir)
      let caught: unknown
      try {
        await abortMerge('foo', { repositoryRoot: repoRoot, homeRoot })
      } catch (error) {
        caught = error
      }
      expect(isSkillboxError(caught)).toBe(true)
      expect(caught).toMatchObject({ code: ErrorCode.MERGE_NOT_IN_PROGRESS })
    })
  })
})

describe('mergeSkill — mode guards', () => {
  it('refuses a local-mode skill with MERGE_NO_BASE', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const localDir = path.join(repoRoot, 'skills', 'bar')
      await writeFileRecursive(localDir, 'SKILL.md', '# Bar\n')
      const manifest = addSkill(emptyManifest(), 'bar', {
        source: { type: 'local', path: 'skills/bar' },
      })
      await writeManifest(repoRoot, manifest)
      const lockfile = emptyLockfile()
      lockfile.skills.bar = createLockedSkill({
        mode: 'local',
        source: { type: 'local', path: 'skills/bar' },
        integrity: await computeSkillIntegrity(localDir),
      })
      await writeLockfile(repoRoot, lockfile)

      let caught: unknown
      try {
        await mergeSkill('bar', { repositoryRoot: repoRoot, homeRoot: path.join(dir, 'home') })
      } catch (error) {
        caught = error
      }
      expect(isSkillboxError(caught)).toBe(true)
      expect(caught).toMatchObject({ code: ErrorCode.MERGE_NO_BASE })
    })
  })

  it('merges a managed skill into its library runtime and re-pins the revision', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot)

      const managedDir = path.join(homeRoot, 'library', 'managed', 'foo')
      // Disjoint changes: local edits SKILL.md, upstream edits notes.md.
      await writeFileRecursive(managedDir, 'SKILL.md', '# Foo\nlocal line\n')
      await writeFileRecursive(managedDir, 'notes.md', 'base notes\n')

      const baseFixture = path.join(dir, 'fixtures', 'rev1')
      await writeFileRecursive(baseFixture, 'SKILL.md', '# Foo\nbase line\n')
      await writeFileRecursive(baseFixture, 'notes.md', 'base notes\n')
      const upstreamFixture = path.join(dir, 'fixtures', 'rev2')
      await writeFileRecursive(upstreamFixture, 'SKILL.md', '# Foo\nbase line\n')
      await writeFileRecursive(upstreamFixture, 'notes.md', 'upstream notes\n')

      const source = { type: 'github' as const, repo: 'acme/foo' }
      const manifest = addSkill(emptyManifest(), 'foo', { source })
      await writeManifest(repoRoot, manifest)
      const lockfile = emptyLockfile()
      const locked = createLockedSkill({
        mode: 'managed',
        source,
        integrity: await computeSkillIntegrity(managedDir),
      })
      locked.revision = 'rev1'
      locked.upstream = { source, baseRevision: 'rev1', latestRevision: 'rev2' }
      lockfile.skills.foo = locked
      await writeLockfile(repoRoot, lockfile)

      const provider = new FakeGithubProvider(
        new Map([
          ['rev1', baseFixture],
          ['rev2', upstreamFixture],
        ]),
        'rev2',
      )
      const result = await mergeSkill('foo', {
        repositoryRoot: repoRoot,
        homeRoot,
        registry: registryWith(provider),
      })
      expect(result.conflicts).toEqual([])
      expect(result.baseRevision).toBe('rev2')

      // Merged into the library runtime.
      expect(await readFileText(managedDir, 'SKILL.md')).toBe('# Foo\nlocal line\n')
      expect(await readFileText(managedDir, 'notes.md')).toBe('upstream notes\n')

      const merged = await mergedLocked(repoRoot)
      expect(merged?.revision).toBe('rev2')
      expect(merged?.upstream?.baseRevision).toBe('rev2')
      expect(merged?.integrity).toBe(await computeSkillIntegrity(managedDir))
    })
  })
})
