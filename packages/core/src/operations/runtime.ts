import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { ErrorCode, SkillboxError } from '../errors.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { BackupIndexStore, type StoredBackupIndexEntry } from './backup-index.js'
import { acquireOperationLock, repositoryKey } from './lock.js'
import { OperationJournal } from './journal.js'
import { captureSnapshot, restoreSnapshot, type OperationSnapshot } from './snapshot.js'
import {
  systemOperationClock,
  type OperationClock,
  type OperationKind,
  type OperationOwner,
  type SnapshotTarget,
} from './types.js'

export interface OperationRuntimeOptions {
  repositoryRoot: string
  homeRoot?: string
  owner?: OperationOwner
  clock?: OperationClock
  maxBackups?: number
}

export interface OperationRunOptions<T> {
  kind: OperationKind
  targets: readonly string[]
  execute: () => Promise<T>
  verify?: (result: T) => Promise<void>
  /**
   * Whether the completed operation is exposed through user-level rollback.
   * Git-aware operations can retain their own restore point while still using
   * this runtime for exclusive locking and crash journaling.
   */
  retainForRollback?: boolean
}

export interface OperationRunResult<T> {
  operationId: string
  result: T
}

export interface RollbackOperationOptions extends OperationRuntimeOptions {
  operationId?: string
}

export interface RollbackOperationResult {
  operationId: string
  restoredTargets: string[]
}

/**
 * Shared mutation boundary. It deliberately has a small API: callers declare
 * every restorable target, then provide mutation and optional verification.
 */
export class OperationRuntime {
  private readonly repositoryRoot: string
  private readonly layout: ReturnType<typeof buildSkillboxHomeLayout>
  private readonly owner: OperationOwner
  private readonly clock: OperationClock
  private readonly maxBackups: number

  constructor(options: OperationRuntimeOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot)
    this.layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())
    this.owner = options.owner ?? { id: randomUUID(), pid: process.pid }
    this.clock = options.clock ?? systemOperationClock
    this.maxBackups = options.maxBackups ?? 20
  }

  async runExclusive<T>(options: OperationRunOptions<T>): Promise<OperationRunResult<T>> {
    const lock = await acquireOperationLock({
      repositoryRoot: this.repositoryRoot,
      stateRoot: this.layout.runtimeLocks,
      owner: this.owner,
      clock: this.clock,
    })
    try {
      const journal = new OperationJournal({
        repositoryRoot: this.repositoryRoot,
        stateRoot: this.layout.operations,
        clock: this.clock,
      })
      const key = repositoryKey(this.repositoryRoot)
      await this.assertNoIncompleteJournal(journal, key)
      const operationId = randomUUID()
      const record = await journal.create({
        operationId,
        kind: options.kind,
        owner: this.owner,
        stage: 'prepare',
      })
      const retainForRollback = options.retainForRollback ?? true
      const snapshots = retainForRollback ? await this.capture(operationId, options.targets) : []
      const index = retainForRollback
        ? new BackupIndexStore(path.join(this.layout.backups, 'index.json'))
        : undefined
      if (retainForRollback) {
        await this.writeSnapshotManifest(operationId, snapshots)
        await index!.add(this.backupEntry(operationId, key, snapshots))
      }
      await journal.write({ ...record, stage: 'mutate', status: 'running' })
      try {
        const result = await options.execute()
        await options.verify?.(result)
        const completed = await journal.read(operationId)
        if (completed === undefined)
          throw new SkillboxError(
            ErrorCode.OPERATION_JOURNAL_INVALID,
            'Operation journal disappeared',
          )
        await journal.write({ ...completed, stage: 'complete', status: 'completed' })
        if (index !== undefined) {
          await index.markCompleted(operationId, new Date(this.clock.now()).toISOString())
          await index.prune({ maxCompleted: this.maxBackups })
        }
        return { operationId, result }
      } catch (error) {
        const current = await journal.read(operationId)
        if (current !== undefined)
          await journal.write({ ...current, stage: 'rollback', status: 'running' })
        try {
          await this.restore(snapshots)
          const rollback = await journal.read(operationId)
          if (rollback !== undefined)
            await journal.write({ ...rollback, stage: 'rolled-back', status: 'rolled-back' })
        } catch (rollbackError) {
          throw new SkillboxError(
            ErrorCode.OPERATION_RECOVERY_REQUIRED,
            'Operation failed and automatic recovery was incomplete',
            { cause: rollbackError, recoverable: true },
          )
        }
        throw error
      }
    } finally {
      await lock.release()
    }
  }

  async rollback(operationId?: string): Promise<RollbackOperationResult> {
    const lock = await acquireOperationLock({
      repositoryRoot: this.repositoryRoot,
      stateRoot: this.layout.runtimeLocks,
      owner: this.owner,
      clock: this.clock,
    })
    try {
      const index = new BackupIndexStore(path.join(this.layout.backups, 'index.json'))
      const selectedId = operationId ?? (await this.latestRollbackId(index))
      const entry = await index.requireCompleted(
        selectedId,
        repositoryKey(this.repositoryRoot),
        new Date(this.clock.now()),
      )
      const snapshots = await this.readSnapshotManifest(entry)
      await this.restore(snapshots)
      return {
        operationId: entry.operationId,
        restoredTargets: snapshots.map((snapshot) => snapshot.targetPath),
      }
    } finally {
      await lock.release()
    }
  }

  private async latestRollbackId(index: BackupIndexStore): Promise<string> {
    const key = repositoryKey(this.repositoryRoot)
    const candidates = (await index.list())
      .filter((entry) => entry.repositoryKey === key && entry.state === 'completed')
      .sort((left, right) => Date.parse(right.completedAt!) - Date.parse(left.completedAt!))
    const latest = candidates[0]
    if (latest === undefined)
      throw new SkillboxError(
        ErrorCode.OPERATION_BACKUP_NOT_FOUND,
        'No completed operation is available to roll back',
        { recoverable: true },
      )
    return latest.operationId
  }

  private async assertNoIncompleteJournal(journal: OperationJournal, key: string): Promise<void> {
    const incomplete = (await journal.list()).find(
      (record) => record.repositoryKey === key && record.status === 'running',
    )
    if (incomplete !== undefined) {
      throw new SkillboxError(
        ErrorCode.OPERATION_RECOVERY_REQUIRED,
        `Operation "${incomplete.operationId}" did not finish. Recover it before starting another mutation.`,
        { recoverable: true, context: { operationId: incomplete.operationId } },
      )
    }
  }

  private async capture(
    operationId: string,
    targets: readonly string[],
  ): Promise<OperationSnapshot[]> {
    const allowedRoots = [this.repositoryRoot, this.layout.root]
    return Promise.all(
      targets.map((target, index) =>
        captureSnapshot({
          targetPath: target,
          storagePath: path.join(this.layout.backups, operationId, String(index)),
          allowedRoots,
        }),
      ),
    )
  }

  private async writeSnapshotManifest(
    operationId: string,
    snapshots: readonly OperationSnapshot[],
  ): Promise<void> {
    const target = path.join(this.layout.backups, operationId, 'snapshots.json')
    await atomicWriteFile(target, `${JSON.stringify({ version: 1, snapshots })}\n`)
  }

  private async readSnapshotManifest(entry: StoredBackupIndexEntry): Promise<OperationSnapshot[]> {
    const target = path.join(this.layout.backups, entry.snapshotId, 'snapshots.json')
    const filesystem = new FilesystemService()
    let parsed: unknown
    try {
      parsed = JSON.parse(await filesystem.readFile(target))
    } catch (error) {
      throw new SkillboxError(
        ErrorCode.OPERATION_ROLLBACK_INVALID,
        `Snapshot manifest for "${entry.operationId}" is unavailable`,
        { cause: error },
      )
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { snapshots?: unknown }).snapshots)
    ) {
      throw new SkillboxError(
        ErrorCode.OPERATION_ROLLBACK_INVALID,
        `Snapshot manifest for "${entry.operationId}" is invalid`,
      )
    }
    return (parsed as { snapshots: OperationSnapshot[] }).snapshots
  }

  private async restore(snapshots: readonly OperationSnapshot[]): Promise<void> {
    const allowedRoots = [this.repositoryRoot, this.layout.root]
    for (const snapshot of [...snapshots].reverse())
      await restoreSnapshot({ snapshot, allowedRoots })
  }

  private backupEntry(
    operationId: string,
    key: string,
    snapshots: readonly OperationSnapshot[],
  ): StoredBackupIndexEntry {
    const now = new Date(this.clock.now()).toISOString()
    const targets: SnapshotTarget[] = snapshots.map((snapshot) => snapshot.target)
    return {
      operationId,
      repositoryKey: key,
      snapshotId: operationId,
      createdAt: now,
      targets,
      snapshotPaths: snapshots.map((snapshot) => snapshot.storagePath),
      state: 'active',
    }
  }
}

export function createOperationRuntime(options: OperationRuntimeOptions): OperationRuntime {
  return new OperationRuntime(options)
}

export async function rollbackOperation(
  options: RollbackOperationOptions,
): Promise<RollbackOperationResult> {
  return createOperationRuntime(options).rollback(options.operationId)
}
