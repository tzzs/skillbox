import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { ErrorCode } from '../errors.js'
import { readLockfile, writeLockfile } from '../lockfile/index.js'
import { addSkill, emptyManifest, readManifest, writeManifest } from '../manifest/index.js'
import type { NormalizedSource, RegistryProvider } from '../registry/types.js'
import { restoreManagedSkill } from './restore.js'
import { BackupService } from '../backup/index.js'
import { modifyManagedCopy, seedManagedSkill } from './test-utils.js'

/** Content that reproduces the seeded managed runtime byte-for-byte. */
const UPSTREAM_FILES: Record<string, string> = {
  'SKILL.md': '# hello\n',
  'notes.md': 'original\n',
}

/** Fake github provider that materializes `files` into the download dir. */
class FakeProvider implements RegistryProvider {
  readonly id = 'github'
  downloaded: Array<{ source: NormalizedSource; revision: string }> = []
  files: Record<string, string> = { ...UPSTREAM_FILES }
  failDownload = false

  async search(): Promise<never[]> {
    return []
  }

  async resolve(source: NormalizedSource) {
    return { source, revision: 'abc123' }
  }

  async download(source: NormalizedSource, revision: string, targetDir: string): Promise<void> {
    this.downloaded.push({ source, revision })
    if (this.failDownload) {
      throw new Error('injected download failure')
    }
    await fs.mkdir(targetDir, { recursive: true })
    for (const [name, content] of Object.entries(this.files)) {
      await fs.writeFile(path.join(targetDir, name), content)
    }
  }

  async getLatestRevision(): Promise<string> {
    return 'abc123'
  }
}

/** Fails the first copy whose destination is `target` (used for rollback tests). */
class FailFirstCopy extends FilesystemService {
  private failed = false
  constructor(private readonly target: string) {
    super()
  }
  override async copy(source: string, destination: string): Promise<void> {
    if (!this.failed && destination === this.target) {
      this.failed = true
      throw new Error('injected copy failure')
    }
    return super.copy(source, destination)
  }
}

/** Restore backups under `~/.skillbox/state/backups/restore` (parents persist). */
async function listBackupDirs(homeRoot: string): Promise<string[]> {
  const backups = path.join(homeRoot, 'state', 'backups', 'restore')
  try {
    return await fs.readdir(backups)
  } catch {
    return []
  }
}

describe('restoreManagedSkill', () => {
  it('restores a modified managed runtime to the pinned revision (M17.3)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed) // diverge from the locked integrity
      const provider = new FakeProvider()

      const result = await restoreManagedSkill(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
        provider,
      })

      expect(result.mode).toBe('managed')
      expect(result.unchanged).toBe(false)
      expect(result.revision).toBe('abc123')
      expect(result.integrity).toBe(seed.lockedIntegrity)
      expect(result.filesRestored).toBeGreaterThan(0)
      expect(result.materializedPath).toBe(seed.managedPath)
      expect(result.backupPath).toBeDefined()
      expect(provider.downloaded).toEqual([
        {
          source: { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
          revision: 'abc123',
        },
      ])

      // Runtime content now matches the locked integrity (modified status clears).
      expect(await fs.readFile(path.join(seed.managedPath, 'notes.md'), 'utf8')).toBe('original\n')
      await expect(fs.stat(path.join(seed.managedPath, 'edited.md'))).rejects.toThrow()

      // The recovery snapshot of the modified runtime is kept.
      const backupPath = result.backupPath
      expect(backupPath).toBeDefined()
      expect(await fs.readFile(path.join(backupPath as string, 'edited.md'), 'utf8')).toBe(
        'changed\n',
      )

      // Repository Manifest / Lockfile are untouched.
      const manifest = await readManifest(seed.repositoryRoot)
      expect(manifest.skills.hello).toMatchObject({ mode: 'managed' })
      const locked = (await readLockfile(seed.repositoryRoot)).skills.hello
      expect(locked).toMatchObject({ mode: 'managed', revision: 'abc123' })
    })
  })

  it('records the recovery snapshot in the unified backup index (rollback-able)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed)
      const provider = new FakeProvider()

      const result = await restoreManagedSkill(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
        provider,
      })

      // The snapshot is indexed by the unified BackupService.
      const backups = new BackupService({ homeRoot: seed.homeRoot })
      const records = await backups.list()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        operation: 'restore',
        alias: seed.alias,
        kind: 'runtime',
      })

      // `skillbox rollback <id>` puts the pre-restore (modified) runtime back.
      const rollback = await backups.rollback(records[0]?.id ?? '', {
        repositoryRoot: seed.repositoryRoot,
      })
      expect(rollback.filesRestored).toBeGreaterThan(0)
      expect(await fs.readFile(path.join(seed.managedPath, 'edited.md'), 'utf8')).toBe('changed\n')
      expect(result.backupPath).toBe(records[0]?.path)
    })
  })

  it('is a no-op when the runtime already matches the lockfile integrity', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const provider = new FakeProvider()

      const result = await restoreManagedSkill(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
        provider,
      })

      expect(result.unchanged).toBe(true)
      expect(result.filesRestored).toBe(0)
      expect(provider.downloaded).toHaveLength(0)
      expect(result.backupPath).toBeUndefined()
    })
  })

  it('recreates a missing runtime copy from the pinned revision', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir, { withManagedCopy: false })
      const provider = new FakeProvider()

      // Fix the lockfile integrity to what the provider downloads (the seed
      // writes a placeholder when the runtime copy is missing).
      const scratch = path.join(dir, 'scratch')
      await fs.mkdir(scratch, { recursive: true })
      for (const [name, content] of Object.entries(provider.files)) {
        await fs.writeFile(path.join(scratch, name), content)
      }
      const { computeSkillIntegrity } = await import('../integrity/canonical-hash.js')
      const expected = await computeSkillIntegrity(scratch)
      const lockfile = await readLockfile(seed.repositoryRoot)
      const locked = lockfile.skills.hello
      expect(locked).toBeDefined()
      if (locked !== undefined) locked.integrity = expected
      await writeLockfile(seed.repositoryRoot, lockfile)

      const result = await restoreManagedSkill(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
        provider,
      })

      expect(result.unchanged).toBe(false)
      expect(result.filesRestored).toBeGreaterThan(0)
      expect(provider.downloaded).toHaveLength(1)
      expect(await fs.readFile(path.join(seed.managedPath, 'SKILL.md'), 'utf8')).toBe('# hello\n')
    })
  })

  it('rejects an unknown skill (SKILL_NOT_FOUND)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await expect(
        restoreManagedSkill('ghost', {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          provider: new FakeProvider(),
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SKILL_NOT_FOUND })
    })
  })

  it('rejects non-managed skills (LIFECYCLE_ILLEGAL_TRANSITION)', async () => {
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
        restoreManagedSkill('hello', {
          repositoryRoot: repo,
          homeRoot: path.join(dir, 'home'),
          provider: new FakeProvider(),
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
        context: { mode: 'local' },
      })
    })
  })

  it('rejects a missing locked entry (RESTORE_FAILED)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir, { noLockEntry: true })
      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          provider: new FakeProvider(),
        }),
      ).rejects.toMatchObject({ code: ErrorCode.RESTORE_FAILED })
    })
  })

  it('rejects a locked entry without a pinned revision (RESTORE_FAILED)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const lockfile = await readLockfile(seed.repositoryRoot)
      const locked = lockfile.skills.hello
      expect(locked).toBeDefined()
      delete locked?.revision
      await writeLockfile(seed.repositoryRoot, lockfile)

      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          provider: new FakeProvider(),
        }),
      ).rejects.toMatchObject({ code: ErrorCode.RESTORE_FAILED })
    })
  })

  it('fails with INTEGRITY_MISMATCH and keeps the modified runtime when the pinned content diverged', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed)
      const provider = new FakeProvider()
      provider.files = { 'SKILL.md': '# different\n', 'notes.md': 'diverged\n' }

      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          provider,
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.INTEGRITY_MISMATCH,
        recoverable: true,
      })

      // The modified runtime is untouched and the backup is cleaned up.
      expect(await fs.readFile(path.join(seed.managedPath, 'edited.md'), 'utf8')).toBe('changed\n')
      expect(await listBackupDirs(seed.homeRoot)).toHaveLength(0)
    })
  })

  it('keeps the modified runtime when the download fails (rollback)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed)
      const provider = new FakeProvider()
      provider.failDownload = true

      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          provider,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.RESTORE_FAILED })

      expect(await fs.readFile(path.join(seed.managedPath, 'edited.md'), 'utf8')).toBe('changed\n')
      expect(await listBackupDirs(seed.homeRoot)).toHaveLength(0)
      const tmpChildren = await fs.readdir(path.join(seed.homeRoot, 'tmp'))
      expect(tmpChildren).toHaveLength(0)
    })
  })

  it('restores the pre-restore runtime when materialize fails midway (rollback)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed)
      const provider = new FakeProvider()
      const failing = new FailFirstCopy(seed.managedPath)

      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          provider,
          filesystem: failing,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.RESTORE_FAILED })

      // The pre-restore (modified) runtime is restored from the backup.
      expect(await fs.readFile(path.join(seed.managedPath, 'edited.md'), 'utf8')).toBe('changed\n')
      expect(await fs.readFile(path.join(seed.managedPath, 'notes.md'), 'utf8')).toBe('original\n')
      // No backup or download leftovers.
      expect(await listBackupDirs(seed.homeRoot)).toHaveLength(0)
      const tmpChildren = await fs.readdir(path.join(seed.homeRoot, 'tmp'))
      expect(tmpChildren).toHaveLength(0)
    })
  })
})
