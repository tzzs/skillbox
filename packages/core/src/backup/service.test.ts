import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { ErrorCode } from '../errors.js'
import { BackupService, backupDir } from './service.js'

/** Seeds a source directory with a couple of files. */
async function seedSource(dir: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
}

describe('BackupService', () => {
  it('records and lists backups newest first', async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, 'home')
      const repo = path.join(dir, 'repo')
      const source = path.join(dir, 'runtime', 'hello')
      await seedSource(source, { 'SKILL.md': '# hello\n' })
      const service = new BackupService({ homeRoot: home })

      const id = 'remove-hello-1'
      const target = backupDir(home, id)
      await fs.cp(source, target, { recursive: true })
      await service.record({
        id,
        kind: 'runtime',
        operation: 'remove',
        alias: 'hello',
        path: target,
        sourcePath: source,
        repositoryRoot: repo,
      })

      const list = await service.list()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ id, kind: 'runtime', alias: 'hello', operation: 'remove' })
      expect(await service.get(id)).toBeDefined()
      expect(await service.get('ghost')).toBeUndefined()
    })
  })

  it('rolls back a runtime backup onto its source path', async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, 'home')
      const repo = path.join(dir, 'repo')
      const source = path.join(dir, 'library', 'managed', 'hello')
      await seedSource(source, { 'SKILL.md': '# hello\n', 'edited.md': 'local\n' })
      const service = new BackupService({ homeRoot: home })

      const id = 'restore-hello-1'
      const target = backupDir(home, id)
      await fs.cp(source, target, { recursive: true })
      await service.record({
        id,
        kind: 'runtime',
        operation: 'restore',
        alias: 'hello',
        path: target,
        sourcePath: source,
        repositoryRoot: repo,
      })

      // Simulate the restore having replaced the runtime.
      await fs.rm(source, { recursive: true, force: true })
      await seedSource(source, { 'SKILL.md': '# fresh\n' })

      const result = await service.rollback(id, { repositoryRoot: repo })

      expect(result).toMatchObject({ id, operation: 'restore', alias: 'hello', kind: 'runtime' })
      expect(result.filesRestored).toBe(2)
      expect(await fs.readFile(path.join(source, 'edited.md'), 'utf8')).toBe('local\n')
    })
  })

  it('rejects an unknown backup id (BACKUP_NOT_FOUND)', async () => {
    await withTempDir(async (dir) => {
      const service = new BackupService({ homeRoot: path.join(dir, 'home') })
      await expect(service.rollback('nope', { repositoryRoot: dir })).rejects.toMatchObject({
        code: ErrorCode.BACKUP_NOT_FOUND,
      })
    })
  })

  it('rejects a backup whose content is missing (BACKUP_INCOMPLETE)', async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, 'home')
      const source = path.join(dir, 'source')
      await seedSource(source, { 'SKILL.md': '# x\n' })
      const service = new BackupService({ homeRoot: home })
      const id = 'restore-hello-missing'
      const target = backupDir(home, id)
      await fs.cp(source, target, { recursive: true })
      await service.record({
        id,
        kind: 'runtime',
        operation: 'restore',
        alias: 'hello',
        path: target,
        sourcePath: source,
        repositoryRoot: dir,
      })
      // The backup content disappears (e.g. user cleaned the store).
      await fs.rm(target, { recursive: true, force: true })

      await expect(service.rollback(id, { repositoryRoot: dir })).rejects.toMatchObject({
        code: ErrorCode.BACKUP_INCOMPLETE,
      })
    })
  })

  it('refuses a cross-repository rollback (BACKUP_REPOSITORY_MISMATCH)', async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, 'home')
      const repoA = path.join(dir, 'repo-a')
      const repoB = path.join(dir, 'repo-b')
      const source = path.join(dir, 'source')
      await seedSource(source, { 'SKILL.md': '# x\n' })
      const service = new BackupService({ homeRoot: home })
      const id = 'restore-hello-cross'
      const target = backupDir(home, id)
      await fs.cp(source, target, { recursive: true })
      await service.record({
        id,
        kind: 'runtime',
        operation: 'restore',
        alias: 'hello',
        path: target,
        sourcePath: source,
        repositoryRoot: repoA,
      })

      await expect(service.rollback(id, { repositoryRoot: repoB })).rejects.toMatchObject({
        code: ErrorCode.BACKUP_REPOSITORY_MISMATCH,
      })
    })
  })

  it('prunes old backups per operation+alias key (retention)', async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, 'home')
      const source = path.join(dir, 'source')
      await seedSource(source, { 'SKILL.md': '# x\n' })
      let tick = 0
      const service = new BackupService({
        homeRoot: home,
        keepPerKey: 2,
        now: () => new Date(1_000 + tick * 1_000),
      })

      for (let i = 0; i < 4; i += 1) {
        tick = i
        const id = `restore-hello-${i}`
        const target = backupDir(home, id)
        await fs.cp(source, target, { recursive: true })
        await service.record({
          id,
          kind: 'runtime',
          operation: 'restore',
          alias: 'hello',
          path: target,
          sourcePath: source,
          repositoryRoot: dir,
        })
      }

      // Retention runs on every record: only the newest 2 per key survive.
      const list = await service.list()
      expect(list.map((record) => record.id)).toEqual(['restore-hello-3', 'restore-hello-2'])
      expect(await service.get('restore-hello-0')).toBeUndefined()
      expect(await service.get('restore-hello-1')).toBeUndefined()
      await expect(fs.stat(backupDir(home, 'restore-hello-0'))).rejects.toThrow()
      await expect(fs.stat(backupDir(home, 'restore-hello-1'))).rejects.toThrow()
    })
  })

  it('forget removes an index entry without touching content', async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, 'home')
      const source = path.join(dir, 'source')
      await seedSource(source, { 'SKILL.md': '# x\n' })
      const service = new BackupService({ homeRoot: home })
      const id = 'restore-hello-forget'
      const target = backupDir(home, id)
      await fs.cp(source, target, { recursive: true })
      await service.record({
        id,
        kind: 'runtime',
        operation: 'restore',
        alias: 'hello',
        path: target,
        sourcePath: source,
        repositoryRoot: dir,
      })

      expect(await service.forget(id)).toBe(true)
      expect(await service.forget(id)).toBe(false)
      expect(await service.get(id)).toBeUndefined()
      // The content dir is untouched (the transaction's rollback removes it).
      await expect(fs.stat(target)).resolves.toBeDefined()
    })
  })
})

describe('metadata snapshots', () => {
  it('restores manifest and lockfile presence atomically', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-backup-meta-'))
    const repo = path.join(home, 'repo')
    await fs.mkdir(repo, { recursive: true })
    const manifest = path.join(repo, 'skillbox.yaml')
    const lockfile = path.join(repo, 'skillbox.lock')
    await fs.writeFile(manifest, 'before-manifest')
    await fs.writeFile(lockfile, 'before-lock')
    const service = new BackupService({ homeRoot: home })
    const record = await service.snapshotMetadata({
      id: 'metadata-1',
      operation: 'install',
      repositoryRoot: repo,
      manifestPath: manifest,
      lockfilePath: lockfile,
    })
    await fs.writeFile(manifest, 'after-manifest')
    await fs.rm(lockfile)
    await service.rollback(record.id, { repositoryRoot: repo })
    expect(await fs.readFile(manifest, 'utf8')).toBe('before-manifest')
    expect(await fs.readFile(lockfile, 'utf8')).toBe('before-lock')
    await fs.rm(home, { recursive: true, force: true })
  })
})
