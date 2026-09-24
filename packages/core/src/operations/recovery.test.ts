import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withTempDir } from '../fs/test-utils.js'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { abandonOperation, listIncompleteOperations, rollbackOperation } from './recovery.js'
import { createOperationRuntime, type OperationRuntimeOptions } from './runtime.js'
import { BackupIndexStore } from './backup-index.js'
import { captureSnapshot } from './snapshot.js'
import { repositoryKey } from './sync-runtime-lock.js'
import { OperationJournal } from './sync-runtime-journal.js'
import type { OperationKind } from './types.js'

const owner = { id: 'recovery-owner', pid: 4242 }

interface Fixture {
  repositoryRoot: string
  homeRoot: string
  manifest: string
  journal: OperationJournal
  runtime: ReturnType<typeof createOperationRuntime>
  options: OperationRuntimeOptions
}

/** A repository + home, wired the same way `skillbox sync` wires them. */
async function fixture(root: string): Promise<Fixture> {
  const repositoryRoot = path.join(root, 'repository')
  const homeRoot = path.join(root, 'home')
  const options = { repositoryRoot, homeRoot }
  await fs.mkdir(repositoryRoot, { recursive: true })
  await fs.mkdir(homeRoot, { recursive: true })
  return {
    ...options,
    manifest: path.join(repositoryRoot, 'skillbox.yaml'),
    journal: new OperationJournal({
      repositoryRoot,
      stateRoot: buildSkillboxHomeLayout(homeRoot).operations,
    }),
    runtime: createOperationRuntime(options),
    options,
  }
}

/**
 * The state a killed process leaves behind: a record that never reached a
 * terminal status. Optionally captured with a restorable snapshot, i.e. a crash
 * after the runtime's prepare phase. Nothing here goes through a code path the
 * runtime itself does not use, because that is the state recovery must read.
 */
async function plantStuckOperation(
  target: Fixture,
  operationId: string,
  options: { kind?: OperationKind; captured?: boolean } = {},
): Promise<void> {
  const kind: OperationKind = options.kind ?? 'install'
  if (options.captured === true) {
    const snapshotDir = path.join(target.homeRoot, 'backups', operationId)
    const snapshot = await captureSnapshot({
      targetPath: target.manifest,
      storagePath: path.join(snapshotDir, '0'),
      allowedRoots: [target.repositoryRoot, target.homeRoot],
    })
    await atomicWriteFile(
      path.join(snapshotDir, 'snapshots.json'),
      `${JSON.stringify({ version: 1, snapshots: [snapshot] })}\n`,
    )
    await new BackupIndexStore(path.join(target.homeRoot, 'backups', 'index.json')).add({
      operationId,
      repositoryKey: repositoryKey(target.repositoryRoot),
      snapshotId: operationId,
      createdAt: new Date().toISOString(),
      targets: [snapshot.target],
      snapshotPaths: [snapshot.storagePath],
      state: 'active',
    })
  }
  await target.journal.create({ operationId, kind, owner, stage: 'mutate' })
}

/** Kills a running mutation so that its automatic rollback cannot restore. */
async function dieMidMutation(target: Fixture): Promise<unknown> {
  return target.runtime
    .runExclusive({
      kind: 'install',
      targets: [target.manifest],
      execute: async () => {
        await fs.writeFile(target.manifest, 'half-written\n', 'utf8')
        // The process is gone before the snapshot can be used again.
        await fs.rm(path.join(target.homeRoot, 'backups'), { recursive: true, force: true })
        throw new Error('process died mid-write')
      },
    })
    .then(
      (result: unknown) => result,
      (error: unknown) => error,
    )
}

/** Every file below `root`, to prove a recovery choice rewrote nothing. */
async function filesBelow(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .sort()
}

const journalFiles = (files: string[]): string[] =>
  files.filter((file) => !file.includes(`${path.sep}operations${path.sep}`))

describe('journal recovery preflight', () => {
  it('refuses every later mutation while a record is stuck, and names how to clear it', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await plantStuckOperation(target, 'op-crashed')

      const failure = await dieMidMutation(target)

      expect(failure).toBeInstanceOf(SkillboxError)
      expect((failure as SkillboxError).code).toBe(ErrorCode.OPERATION_RECOVERY_REQUIRED)
      expect((failure as SkillboxError).context).toMatchObject({ operationId: 'op-crashed' })
      // The message alone has to be actionable: which operation, what it was,
      // and the exact command that clears it.
      expect((failure as SkillboxError).message).toContain('op-crashed')
      expect((failure as SkillboxError).message).toContain('install')
      expect((failure as SkillboxError).message).toContain('skillbox recover')
      expect((failure as SkillboxError).message).toContain('skillbox recover --abandon op-crashed')
      // No silent auto-heal: the refused attempt leaves the record as it was...
      expect(await target.journal.read('op-crashed')).toMatchObject({ status: 'running' })
      // ...and the next attempt is refused in exactly the same way.
      const again = await dieMidMutation(target)
      expect(again).toMatchObject({ code: ErrorCode.OPERATION_RECOVERY_REQUIRED })

      // The state is now readable programmatically, which it never was before.
      const incomplete = await listIncompleteOperations(target.options)
      expect(incomplete).toHaveLength(1)
      expect(incomplete[0]).toMatchObject({
        operationId: 'op-crashed',
        kind: 'install',
        status: 'running',
        stage: 'mutate',
        backupExists: false,
        rollbackAvailable: false,
        abandonCommand: 'skillbox recover --abandon op-crashed',
      })
      expect(incomplete[0]?.rollbackCommand).toBeUndefined()
      expect(incomplete[0]?.rollbackReason).toContain('no restore point')
    })
  })

  it('makes the failed-rollback path name the operation and the command too', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await fs.writeFile(target.manifest, 'before\n', 'utf8')

      const failure = await dieMidMutation(target)

      expect(failure).toMatchObject({ code: ErrorCode.OPERATION_RECOVERY_REQUIRED })
      const message = (failure as SkillboxError).message
      const operationId = (failure as SkillboxError).context?.operationId as string
      expect(message).toContain(operationId)
      expect(message).toContain('automatic rollback could not restore')
      expect(message).toContain(`skillbox recover --abandon ${operationId}`)
      // Nothing healed: the record is still running and blocked.
      expect(await target.journal.read(operationId)).toMatchObject({ status: 'running' })
      // Its backup record is gone with it, so this is the one case where neither
      // choice can put the files back: only `--abandon` is offered, and it says so.
      expect(await listIncompleteOperations(target.options)).toMatchObject([
        { operationId: operationId, backupExists: false, rollbackAvailable: false },
      ])
      expect((await listIncompleteOperations(target.options))[0]?.rollbackReason).toContain(
        'no restore point',
      )
    })
  })
})

describe('abandonOperation', () => {
  it('unblocks mutations without touching any user file', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await fs.writeFile(target.manifest, 'before\n', 'utf8')
      await plantStuckOperation(target, 'op-stuck', { captured: true })
      await fs.writeFile(target.manifest, 'half-written\n', 'utf8')
      const before = await filesBelow(root)

      await expect(
        abandonOperation({ ...target.options, operationId: 'op-stuck' }),
      ).resolves.toEqual({
        operationId: 'op-stuck',
        kind: 'install',
        status: 'abandoned',
        restoredTargets: [],
      })

      expect(await target.journal.read('op-stuck')).toMatchObject({
        status: 'abandoned',
        stage: 'abandoned',
      })
      // The interrupted operation's partial write is still there: no file was
      // restored, added or removed.
      await expect(fs.readFile(target.manifest, 'utf8')).resolves.toBe('half-written\n')
      expect(journalFiles(await filesBelow(root))).toEqual(journalFiles(before))

      // The mutation path is open again.
      await expect(
        target.runtime.runExclusive({
          kind: 'install',
          targets: [],
          retainForRollback: false,
          execute: async () => 'unblocked',
        }),
      ).resolves.toMatchObject({ result: 'unblocked' })

      // An operation that needs no decision is refused, not silently accepted.
      await expect(
        abandonOperation({ ...target.options, operationId: 'op-stuck' }),
      ).rejects.toMatchObject({ code: ErrorCode.OPERATION_JOURNAL_INVALID })
      await expect(
        abandonOperation({ ...target.options, operationId: 'op-never-existed' }),
      ).rejects.toMatchObject({ code: ErrorCode.OPERATION_JOURNAL_INVALID })
    })
  })
})

describe('rollbackOperation as the recovery path', () => {
  it('restores the captured files, closes the record and unblocks mutations', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await fs.writeFile(target.manifest, 'before\n', 'utf8')
      await plantStuckOperation(target, 'op-stuck', { captured: true })
      await fs.writeFile(target.manifest, 'half-written\n', 'utf8')

      await expect(
        rollbackOperation({ ...target.options, operationId: 'op-stuck' }),
      ).resolves.toEqual({
        operationId: 'op-stuck',
        kind: 'install',
        restoredTargets: [target.manifest],
        journalStatus: 'rolled-back',
      })

      expect(await target.journal.read('op-stuck')).toMatchObject({
        status: 'rolled-back',
        stage: 'rolled-back',
      })
      await expect(fs.readFile(target.manifest, 'utf8')).resolves.toBe('before\n')
      await expect(
        target.runtime.runExclusive({
          kind: 'install',
          targets: [],
          retainForRollback: false,
          execute: async () => 'unblocked',
        }),
      ).resolves.toMatchObject({ result: 'unblocked' })
      // Rolling a closed record back twice would rewrite files the user has
      // since edited, so the second attempt is refused.
      await expect(
        rollbackOperation({ ...target.options, operationId: 'op-stuck' }),
      ).rejects.toMatchObject({ code: ErrorCode.OPERATION_ROLLBACK_INVALID })
    })
  })

  it('still closes the journal record of an ordinary completed rollback', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await fs.writeFile(target.manifest, 'before\n', 'utf8')
      const completed = await target.runtime.runExclusive({
        kind: 'restore',
        targets: [target.manifest],
        execute: async () => fs.writeFile(target.manifest, 'after\n', 'utf8'),
      })

      await expect(
        rollbackOperation({ ...target.options, operationId: completed.operationId }),
      ).resolves.toMatchObject({ journalStatus: 'rolled-back' })
      expect(await target.journal.read(completed.operationId)).toMatchObject({
        status: 'rolled-back',
      })
      await expect(fs.readFile(target.manifest, 'utf8')).resolves.toBe('before\n')
      expect(await listIncompleteOperations(target.options)).toEqual([])
    })
  })

  it('refuses to roll back an operation that captured no restore point, and says what to do instead', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await plantStuckOperation(target, 'op-sync', { kind: 'sync' })

      const failure = await rollbackOperation({ ...target.options, operationId: 'op-sync' }).then(
        (result: unknown) => result,
        (error: unknown) => error,
      )

      expect(failure).toMatchObject({ code: ErrorCode.OPERATION_BACKUP_NOT_FOUND })
      const message = (failure as SkillboxError).message
      expect(message).toContain('sync')
      expect(message).toContain('restore-snapshot')
      expect(message).toContain('skillbox recover --abandon op-sync')
      expect(await target.journal.read('op-sync')).toMatchObject({ status: 'running' })
    })
  })
})

describe('listIncompleteOperations', () => {
  it('separates what can be rolled back from what can only be abandoned', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await fs.writeFile(target.manifest, 'before\n', 'utf8')
      await plantStuckOperation(target, 'op-snapshot', { captured: true })
      await plantStuckOperation(target, 'op-sync', { kind: 'sync' })
      await plantStuckOperation(target, 'op-orphan', { captured: true })
      // Its snapshot manifest was pruned away while the record stayed open.
      await fs.rm(path.join(target.homeRoot, 'backups', 'op-orphan', 'snapshots.json'))

      const incomplete = await listIncompleteOperations(target.options)
      const byId = new Map(incomplete.map((operation) => [operation.operationId, operation]))
      expect(byId.get('op-snapshot')).toMatchObject({
        backupExists: true,
        rollbackAvailable: true,
        rollbackCommand: 'skillbox recover --rollback op-snapshot',
        abandonCommand: 'skillbox recover --abandon op-snapshot',
      })
      expect(byId.get('op-orphan')).toMatchObject({ backupExists: true, rollbackAvailable: false })
      expect(byId.get('op-orphan')?.rollbackReason).toContain('manifest is missing')
      expect(byId.get('op-orphan')?.scope).toContain('skillbox.yaml')
      const gitSync = byId.get('op-sync')
      expect(gitSync).toMatchObject({ kind: 'sync', backupExists: false, rollbackAvailable: false })
      expect(gitSync?.rollbackCommand).toBeUndefined()
      expect(gitSync?.rollbackReason).toContain('sync')
      expect(gitSync?.scope).toContain('no restore point')
    })
  })

  it('names the alias or scope an operation recorded while it is still in flight', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await fs.writeFile(target.manifest, 'before\n', 'utf8')

      const running = target.runtime.runExclusive({
        kind: 'install',
        targets: [target.manifest],
        metadata: { alias: 'demo' },
        execute: async () => {
          const operations = await listIncompleteOperations(target.options)
          expect(operations).toHaveLength(1)
          expect(operations[0]).toMatchObject({
            kind: 'install',
            scope: 'demo',
            status: 'running',
            stage: 'mutate',
            backupExists: true,
            rollbackAvailable: true,
          })
          throw new Error('exit after the listing')
        },
      })
      await expect(running).rejects.toThrow('exit after the listing')
    })
  })

  it('is scoped to the repository that owns the journal records', async () => {
    await withTempDir(async (root) => {
      const target = await fixture(root)
      await plantStuckOperation(target, 'op-crashed')
      const other = path.join(root, 'other-repository')
      await fs.mkdir(other, { recursive: true })

      await expect(
        listIncompleteOperations({ repositoryRoot: other, homeRoot: target.homeRoot }),
      ).resolves.toEqual([])
    })
  })
})
