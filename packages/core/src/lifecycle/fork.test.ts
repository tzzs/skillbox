import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { ErrorCode } from '../errors.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { readLockfile, writeLockfile } from '../lockfile/index.js'
import { addSkill, emptyManifest, readManifest, writeManifest } from '../manifest/index.js'
import { createOperationRuntime } from '../operations/index.js'
import { baseSnapshotDir } from './bases.js'
import { forkSkill } from './fork.js'
import { FailingFilesystem, matches, seedManagedSkill } from './test-utils.js'

describe('forkSkill', () => {
  it('forks a managed skill end to end (M17.1)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const { repositoryRoot: repo, homeRoot: home } = seed

      const result = await forkSkill(seed.alias, { repositoryRoot: repo, homeRoot: home })

      expect(result.mode).toBe('forked')
      expect(result.repositoryPath).toBe('skills/hello')
      expect(result.integrity).toBe(seed.lockedIntegrity)
      expect(result.baseRevision).toBe('abc123')
      expect(result.baseIntegrity).toBe(seed.lockedIntegrity)
      expect(result.upstream).toEqual(seed.upstream)
      expect(result.absolutePath).toBe(path.join(repo, 'skills', 'hello'))

      // Repository copy matches the managed content.
      expect(await fs.readFile(path.join(repo, 'skills', 'hello', 'SKILL.md'), 'utf8')).toBe(
        '# hello\n',
      )
      expect(await fs.readFile(path.join(repo, 'skills', 'hello', 'notes.md'), 'utf8')).toBe(
        'original\n',
      )

      // Manifest: source → local, mode → forked, upstream recorded.
      const manifest = await readManifest(repo)
      const entry = manifest.skills.hello!
      expect(entry.mode).toBe('forked')
      expect(entry.source).toEqual({ type: 'local', path: 'skills/hello' })
      expect(entry.upstream).toEqual(seed.upstream)

      // Lockfile: forked entry with base revision / integrity (SPEC §53-54).
      const lockfile = await readLockfile(repo)
      const locked = lockfile.skills.hello
      expect(locked).toMatchObject({
        mode: 'forked',
        source: { type: 'local', path: 'skills/hello' },
        integrity: seed.lockedIntegrity,
      })
      expect(locked?.revision).toBeUndefined()
      expect(locked?.upstream).toEqual({
        source: seed.upstream,
        baseRevision: 'abc123',
        baseIntegrity: seed.lockedIntegrity,
        latestRevision: 'abc123',
      })
    })
  })

  it('saves a git-trackable base snapshot inside the repository (M17.4)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const { repositoryRoot: repo, homeRoot: home } = seed

      const result = await forkSkill(seed.alias, { repositoryRoot: repo, homeRoot: home })

      const expected = baseSnapshotDir(repo, 'hello', 'abc123')
      expect(result.baseSnapshotPath).toBe(expected)
      // Inside the repository → git tracks it (SPEC §58-60).
      expect(path.relative(repo, result.baseSnapshotPath)).not.toMatch(/^\.\./)
      expect(await fs.readFile(path.join(expected, 'SKILL.md'), 'utf8')).toBe('# hello\n')
      expect(await fs.readFile(path.join(expected, 'notes.md'), 'utf8')).toBe('original\n')
      expect(await computeSkillIntegrity(expected)).toBe(seed.lockedIntegrity)
    })
  }, 15_000)

  it('preserves agents and lockfile security/metadata across the fork', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir, { agents: ['claude', 'codex'] })
      const { repositoryRoot: repo, homeRoot: home } = seed
      const lockfile = await readLockfile(repo)
      lockfile.skills.hello!.security = { risk: 'low', scannedAt: '2026-01-01T00:00:00.000Z' }
      lockfile.skills.hello!.metadata = { note: 'keep me' }
      await writeLockfile(repo, lockfile)

      await forkSkill(seed.alias, { repositoryRoot: repo, homeRoot: home })

      const manifest = await readManifest(repo)
      expect(manifest.skills.hello?.agents).toEqual(['claude', 'codex'])

      const locked = (await readLockfile(repo)).skills.hello
      expect(locked?.security).toEqual({ risk: 'low', scannedAt: '2026-01-01T00:00:00.000Z' })
      expect(locked?.metadata).toEqual({ note: 'keep me' })
    })
  })

  it('rejects an unknown skill (SKILL_NOT_FOUND)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await expect(
        forkSkill('ghost', { repositoryRoot: seed.repositoryRoot, homeRoot: seed.homeRoot }),
      ).rejects.toMatchObject({ code: ErrorCode.SKILL_NOT_FOUND })
    })
  })

  it('rejects a non-managed skill (LIFECYCLE_ILLEGAL_TRANSITION)', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo')
      await fs.mkdir(repo, { recursive: true })
      await writeManifest(
        repo,
        addSkill(emptyManifest(), 'hello', {
          source: { type: 'local', path: 'skills/hello' },
          mode: 'local',
        }),
      )
      await fs.mkdir(path.join(repo, 'skills', 'hello'), { recursive: true })
      await fs.writeFile(path.join(repo, 'skills', 'hello', 'SKILL.md'), '# hello\n', 'utf8')

      await expect(
        forkSkill('hello', { repositoryRoot: repo, homeRoot: path.join(dir, 'home') }),
      ).rejects.toMatchObject({
        code: ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
        context: { from: 'local', to: 'forked' },
      })
    })
  })

  it('rejects when the managed runtime copy is missing (SKILL_MISSING)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir, { withManagedCopy: false })
      await expect(
        forkSkill(seed.alias, { repositoryRoot: seed.repositoryRoot, homeRoot: seed.homeRoot }),
      ).rejects.toMatchObject({ code: ErrorCode.SKILL_MISSING })
    })
  })

  it('rejects when the target skills/<alias> already exists (FORK_TARGET_EXISTS)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await fs.mkdir(path.join(seed.repositoryRoot, 'skills', 'hello'), { recursive: true })
      await fs.writeFile(path.join(seed.repositoryRoot, 'skills', 'hello', 'SKILL.md'), 'x\n')

      await expect(
        forkSkill(seed.alias, { repositoryRoot: seed.repositoryRoot, homeRoot: seed.homeRoot }),
      ).rejects.toMatchObject({ code: ErrorCode.FORK_TARGET_EXISTS })
    })
  })

  it('rejects when no locked entry exists (FORK_FAILED)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir, { noLockEntry: true })
      await expect(
        forkSkill(seed.alias, { repositoryRoot: seed.repositoryRoot, homeRoot: seed.homeRoot }),
      ).rejects.toMatchObject({ code: ErrorCode.FORK_FAILED })
    })
  })

  it('rolls back a failed base snapshot (removes the copied directory)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const failing = new FailingFilesystem(matches('.skillbox/bases'))

      await expect(
        forkSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          filesystem: failing,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.LIFECYCLE_BASE_SNAPSHOT_FAILED })

      // No half-forked skill left behind.
      await expect(fs.stat(path.join(seed.repositoryRoot, 'skills', 'hello'))).rejects.toThrow()
      await expect(fs.stat(path.join(seed.repositoryRoot, '.skillbox', 'bases'))).rejects.toThrow()
      const manifest = await readManifest(seed.repositoryRoot)
      expect(manifest.skills.hello).toMatchObject({ mode: 'managed' })
      const lockfile = await readLockfile(seed.repositoryRoot)
      expect(lockfile.skills.hello).toMatchObject({ mode: 'managed' })
    })
  })

  it('restores the manifest when a later step fails (rollback of lockfile write)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)

      // After the skill copy succeeds, make `skillbox.lock` un-renameable (a
      // directory) so the atomic lockfile write fails mid-transaction.
      class LockfileDirInjector extends FailingFilesystem {
        constructor(private readonly repoRoot: string) {
          super()
        }
        override async copy(source: string, destination: string): Promise<void> {
          const result = await super.copy(source, destination)
          // Replace the lockfile with a directory so the atomic lockfile
          // write's final rename fails mid-transaction.
          const lockPath = path.join(this.repoRoot, 'skillbox.lock')
          await fs.rm(lockPath, { force: true })
          await fs.mkdir(lockPath, { recursive: true })
          return result
        }
      }

      await expect(
        forkSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          filesystem: new LockfileDirInjector(seed.repositoryRoot),
        }),
      ).rejects.toThrow()

      // Manifest restored to the pre-fork (managed) state, copied dirs gone.
      const manifest = await readManifest(seed.repositoryRoot)
      expect(manifest.skills.hello).toMatchObject({
        mode: 'managed',
        source: seed.upstream,
      })
      await expect(fs.stat(path.join(seed.repositoryRoot, 'skills', 'hello'))).rejects.toThrow()
      await expect(fs.stat(path.join(seed.repositoryRoot, '.skillbox', 'bases'))).rejects.toThrow()
    })
  })

  it('uses the operation snapshot when compatibility rollback cleanup also fails', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const failing = new FailingFilesystem(
        matches('.skillbox/bases'), // base snapshot copy fails
        matches('skills/hello'), // and the cleanup of the copied dir fails
      )

      await expect(
        forkSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          filesystem: failing,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.LIFECYCLE_ROLLBACK_FAILED })

      // The shared operation boundary restores its own snapshot even though the
      // compatibility cleanup used the intentionally failing filesystem.
      const manifest = await readManifest(seed.repositoryRoot)
      expect(manifest.skills.hello).toMatchObject({ mode: 'managed' })
      await expect(fs.stat(path.join(seed.repositoryRoot, 'skills', 'hello'))).rejects.toThrow()
    })
  })

  it('records a fork snapshot that can be rolled back after success', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await forkSkill(seed.alias, { repositoryRoot: seed.repositoryRoot, homeRoot: seed.homeRoot })

      const rollback = await createOperationRuntime({
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
      }).rollback()

      expect(rollback.restoredTargets).toContain(path.join(seed.repositoryRoot, 'skillbox.yaml'))
      expect((await readManifest(seed.repositoryRoot)).skills.hello).toMatchObject({
        mode: 'managed',
      })
      await expect(fs.stat(path.join(seed.repositoryRoot, 'skills', 'hello'))).rejects.toThrow()
    })
  }, 15_000)
})
