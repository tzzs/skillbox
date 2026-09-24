import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { ErrorCode, SkillboxError } from '../errors.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { BackupIndexStore, type StoredBackupIndexEntry } from './backup-index.js'
import { acquireOperationLock, repositoryKey, type OperationLock } from './sync-runtime-lock.js'
import { OperationJournal } from './sync-runtime-journal.js'
import { captureSnapshot, restoreSnapshot, type OperationSnapshot } from './snapshot.js'
import {
  isTerminalOperationJournalStatus,
  systemOperationClock,
  type OperationClock,
  type OperationJournalRecord,
  type OperationJournalStatus,
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
  /**
   * Descriptive detail (alias / scope) carried on the journal record so
   * `skillbox recover` can tell a human *which* operation is stuck.
   */
  metadata?: Record<string, unknown>
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
  /** Kind recorded in the journal, when the operation left a record. */
  kind?: OperationKind
  /** Terminal status the journal record was closed with, when there was one. */
  journalStatus?: OperationJournalStatus
}

/**
 * The single command prefix a user runs to resolve an unfinished operation.
 * Every message that reports `OPERATION_RECOVERY_REQUIRED` quotes it, so the
 * lockout can never again be a dead end.
 */
export const RECOVERY_COMMAND = 'skillbox recover'

/** What `recover --abandon` records as the reason a record was closed. */
const ABANDON_REASON =
  'Abandoned with `skillbox recover --abandon`: the interrupted operation kept its changes and nothing was restored'

/** One journal record that never reached a terminal status. */
export interface IncompleteOperation {
  operationId: string
  kind: OperationKind
  /** Non-terminal status the record is stuck on (`running`). */
  status: OperationJournalStatus
  /** Milestone the process reached before it died (`prepare`/`mutate`/`rollback`). */
  stage: string
  startedAt: string
  updatedAt: string
  /** Alias/scope the caller recorded, else the targets its snapshot covers. */
  scope: string
  /** True when the operation registered a backup record for this repository. */
  backupExists: boolean
  /** True when `--rollback` can undo it; false means `--abandon` is the only choice. */
  rollbackAvailable: boolean
  /** Why `--rollback` is refused, instead of promising a restore that cannot run. */
  rollbackReason?: string
  abandonCommand: string
  rollbackCommand?: string
}

/** The outcome of either recovery choice. */
export interface OperationRecoveryResult {
  operationId: string
  kind: OperationKind
  /** Terminal status the journal record now carries. */
  status: 'abandoned' | 'rolled-back'
  /** Files restored by the rollback; always empty for `--abandon`. */
  restoredTargets: string[]
}

/** Whether a record can be undone by rollback, and why not. */
interface RollbackAvailability {
  available: boolean
  backupExists: boolean
  targetCount: number
  reason?: string
}

/**
 * Shared mutation boundary. It deliberately has a small API: callers declare
 * every restorable target, then provide mutation and optional verification.
 */
export class OperationRuntime {
  private readonly repositoryRoot: string
  private readonly layout: ReturnType<typeof buildSkillboxHomeLayout>
  private readonly backupIndexPath: string
  private readonly owner: OperationOwner
  private readonly clock: OperationClock
  private readonly maxBackups: number

  constructor(options: OperationRuntimeOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot)
    this.layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())
    this.backupIndexPath = path.join(this.layout.backups, 'index.json')
    this.owner = options.owner ?? { id: randomUUID(), pid: process.pid }
    this.clock = options.clock ?? systemOperationClock
    this.maxBackups = options.maxBackups ?? 20
  }

  async runExclusive<T>(options: OperationRunOptions<T>): Promise<OperationRunResult<T>> {
    const lock = await this.acquireLock()
    try {
      const journal = this.journal()
      const key = repositoryKey(this.repositoryRoot)
      await this.assertNoIncompleteJournal(journal, key)
      const operationId = randomUUID()
      const record = await journal.create({
        operationId,
        kind: options.kind,
        owner: this.owner,
        stage: 'prepare',
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      })
      const retainForRollback = options.retainForRollback ?? true
      const snapshots = retainForRollback ? await this.capture(operationId, options.targets) : []
      const index = retainForRollback ? new BackupIndexStore(this.backupIndexPath) : undefined
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
          throw await this.recoveryRequiredError(
            current ?? record,
            'failed and its automatic rollback could not restore it',
            rollbackError,
          )
        }
        throw error
      }
    } finally {
      await lock.release()
    }
  }

  /**
   * Restores an operation's captured targets and closes its journal record.
   * Called with the id of an unfinished operation this is `skillbox recover
   * --rollback`, i.e. the recovery path the runtime never exposed before.
   */
  async rollback(operationId?: string): Promise<RollbackOperationResult> {
    const lock = await this.acquireLock()
    try {
      const journal = this.journal()
      const index = new BackupIndexStore(this.backupIndexPath)
      const selectedId = operationId ?? (await this.latestRollbackId(index))
      const entry = await this.restorableEntry(journal, index, selectedId)
      const snapshots = await this.readSnapshotManifest(entry)
      await this.restore(snapshots)
      // A rollback that left the record `running` would keep every later
      // mutation refused, which would make the recovery command useless.
      const record = await journal.read(selectedId)
      if (record !== undefined)
        await journal.write({ ...record, stage: 'rolled-back', status: 'rolled-back' })
      return {
        operationId: entry.operationId,
        restoredTargets: snapshots.map((snapshot) => snapshot.targetPath),
        ...(record === undefined
          ? {}
          : { kind: record.kind, journalStatus: 'rolled-back' as const }),
      }
    } finally {
      await lock.release()
    }
  }

  /**
   * Closes an unfinished journal record as `abandoned` so mutations can run
   * again. It restores nothing on purpose: abandoning means "keep whatever the
   * dead operation already wrote", and it never opens a user file. The
   * operation's backup record stays `active` (never `completed`), so a later
   * bare `rollback` cannot silently pick it up instead.
   */
  async abandon(operationId: string, reason?: string): Promise<OperationRecoveryResult> {
    const lock = await this.acquireLock()
    try {
      const journal = this.journal()
      const record = await journal.read(operationId)
      if (record === undefined)
        throw new SkillboxError(
          ErrorCode.OPERATION_JOURNAL_INVALID,
          `Operation "${operationId}" has no journal record in this repository. Run \`${RECOVERY_COMMAND}\` to list the operations that do need a decision.`,
          { recoverable: true, context: { operationId } },
        )
      if (isTerminalOperationJournalStatus(record.status))
        throw new SkillboxError(
          ErrorCode.OPERATION_JOURNAL_INVALID,
          `Operation "${operationId}" (${record.kind}) is already ${record.status}, so it blocks nothing. Run \`${RECOVERY_COMMAND}\` to list the operations that do.`,
          { recoverable: true, context: { operationId, status: record.status } },
        )
      await journal.write({
        ...record,
        stage: 'abandoned',
        status: 'abandoned',
        error: {
          message: reason ?? ABANDON_REASON,
          code: ErrorCode.OPERATION_RECOVERY_REQUIRED,
        },
      })
      return { operationId, kind: record.kind, status: 'abandoned', restoredTargets: [] }
    } finally {
      await lock.release()
    }
  }

  /**
   * Every record of this repository that never reached a terminal status: the
   * crash state that refuses new mutations. Deliberately read-only and
   * lock-free, so `skillbox recover` and `skillbox doctor` can report it even
   * while another process owns the mutation lock. It cannot tell a dead process
   * from one still mid-write — a journal record has no heartbeat — which is why
   * nothing here is ever cleared automatically.
   */
  async listIncomplete(): Promise<IncompleteOperation[]> {
    const records = (await this.journal().list()).filter(
      (record) => !isTerminalOperationJournalStatus(record.status),
    )
    if (records.length === 0) return []
    const entries = await this.backupEntries()
    const operations: IncompleteOperation[] = []
    for (const record of records) {
      const entry = entries.find(
        (item) =>
          item.operationId === record.operationId && item.repositoryKey === record.repositoryKey,
      )
      const availability = await this.rollbackAvailability(record, entry)
      operations.push({
        operationId: record.operationId,
        kind: record.kind,
        status: record.status,
        stage: record.stage,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        scope: describeScope(record, entry),
        backupExists: availability.backupExists,
        rollbackAvailable: availability.available,
        ...(availability.reason === undefined ? {} : { rollbackReason: availability.reason }),
        abandonCommand: `${RECOVERY_COMMAND} --abandon ${record.operationId}`,
        ...(availability.available
          ? { rollbackCommand: `${RECOVERY_COMMAND} --rollback ${record.operationId}` }
          : {}),
      })
    }
    return operations
  }

  private async acquireLock(): Promise<OperationLock> {
    return acquireOperationLock({
      repositoryRoot: this.repositoryRoot,
      stateRoot: this.layout.runtimeLocks,
      owner: this.owner,
      clock: this.clock,
    })
  }

  private journal(): OperationJournal {
    return new OperationJournal({
      repositoryRoot: this.repositoryRoot,
      stateRoot: this.layout.operations,
      clock: this.clock,
    })
  }

  /** Path of a stored snapshot manifest; matches `readSnapshotManifest`. */
  private snapshotManifestPath(entry: StoredBackupIndexEntry): string {
    return path.join(this.layout.backups, entry.snapshotId, 'snapshots.json')
  }

  /** Backup records of this home, tolerating an index that cannot be read. */
  private async backupEntries(): Promise<StoredBackupIndexEntry[]> {
    try {
      return await new BackupIndexStore(this.backupIndexPath).list()
    } catch {
      // An unreadable index can only mean no restore point is offered; the
      // journal listing is still what the user has to resolve.
      return []
    }
  }

  private async rollbackAvailability(
    record: OperationJournalRecord,
    entry?: StoredBackupIndexEntry,
  ): Promise<RollbackAvailability> {
    const snapshot =
      entry ??
      (await this.backupEntries()).find(
        (item) =>
          item.operationId === record.operationId && item.repositoryKey === record.repositoryKey,
      )
    if (snapshot === undefined)
      return {
        available: false,
        backupExists: false,
        targetCount: 0,
        reason: noRestorePointReason(record.kind),
      }
    if (!(await new FilesystemService().exists(this.snapshotManifestPath(snapshot))))
      return {
        available: false,
        backupExists: true,
        targetCount: snapshot.targets.length,
        reason:
          'its snapshot manifest is missing from the backup store, so there is nothing to restore',
      }
    return { available: true, backupExists: true, targetCount: snapshot.targets.length }
  }

  /**
   * The backup an explicit rollback may restore. A `completed` record is the
   * ordinary user-level case; an `active` one belongs to an operation that died
   * before finishing, and rolling that back is exactly what recovery offers —
   * but only while its journal record still needs it, so the snapshot of an
   * already-closed operation is never silently re-applied.
   */
  private async restorableEntry(
    journal: OperationJournal,
    index: BackupIndexStore,
    operationId: string,
  ): Promise<StoredBackupIndexEntry> {
    const record = await journal.read(operationId)
    const entry = (await index.list()).find((item) => item.operationId === operationId)
    if (entry === undefined)
      throw new SkillboxError(
        ErrorCode.OPERATION_BACKUP_NOT_FOUND,
        `Operation "${operationId}" recorded no restore point, so its files cannot be restored: ${noRestorePointReason(record?.kind)}.` +
          `\n  keep changes  ${RECOVERY_COMMAND} --abandon ${operationId}`,
        { recoverable: true, context: { operationId } },
      )
    if (entry.state === 'completed')
      return index.requireCompleted(
        operationId,
        repositoryKey(this.repositoryRoot),
        new Date(this.clock.now()),
      )
    if (entry.repositoryKey !== repositoryKey(this.repositoryRoot))
      throw new SkillboxError(
        ErrorCode.OPERATION_ROLLBACK_REPOSITORY_MISMATCH,
        'Backup belongs to a different repository',
      )
    if (record === undefined || isTerminalOperationJournalStatus(record.status))
      throw new SkillboxError(
        ErrorCode.OPERATION_ROLLBACK_INVALID,
        `Backup "${operationId}" is not completed` +
          (record === undefined
            ? ''
            : ` and its journal record is already ${record.status}, so it has nothing left to recover`) +
          `.`,
        { recoverable: true, context: { operationId } },
      )
    return entry
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

  /**
   * Refuses a new mutation while a record is unfinished, and says exactly how to
   * finish it: which operation, what it was doing, and the command for each
   * choice. Nothing is decided on the user's behalf.
   */
  private async recoveryRequiredError(
    record: OperationJournalRecord,
    summary: string,
    cause?: unknown,
  ): Promise<SkillboxError> {
    const rollback = await this.rollbackAvailability(record)
    const choices = [
      `  inspect        ${RECOVERY_COMMAND}`,
      `  keep changes   ${RECOVERY_COMMAND} --abandon ${record.operationId}  (closes the record; no file is restored)`,
    ]
    choices.push(
      rollback.available
        ? `  undo changes   ${RECOVERY_COMMAND} --rollback ${record.operationId}  (restores ${rollback.targetCount} file(s))`
        : `  undo changes   unavailable — ${rollback.reason ?? 'no restore point was recorded'}`,
    )
    return new SkillboxError(
      ErrorCode.OPERATION_RECOVERY_REQUIRED,
      [
        `Operation "${record.operationId}" (${record.kind}) ${summary}.`,
        `Its journal record is still "${record.status}" at stage "${record.stage}", so every further mutation is refused until it is resolved.`,
        ...choices,
      ].join('\n'),
      {
        ...(cause === undefined ? {} : { cause }),
        recoverable: true,
        context: {
          operationId: record.operationId,
          kind: record.kind,
          stage: record.stage,
          startedAt: record.startedAt,
          rollbackAvailable: rollback.available,
        },
      },
    )
  }

  private async assertNoIncompleteJournal(journal: OperationJournal, key: string): Promise<void> {
    const incomplete = (await journal.list()).find(
      (record) => record.repositoryKey === key && !isTerminalOperationJournalStatus(record.status),
    )
    if (incomplete !== undefined)
      throw await this.recoveryRequiredError(incomplete, 'did not finish')
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

/**
 * Why `--rollback` cannot offer to undo an operation that captured no restore
 * point. Naming the reason beats offering a flag that would fail: a git-backed
 * sync deliberately keeps its checkpoints in Git.
 */
function noRestorePointReason(kind: OperationKind | undefined): string {
  return kind === 'sync'
    ? 'a git-backed "sync" journals its mutation but keeps its own checkpoints in Git (`skillbox sync --multi-device --restore-snapshot <id>`), so it recorded no restore point here'
    : 'the operation recorded no restore point before it ran, so there is nothing for --rollback to restore'
}

/** What the operation was working on, as far as its record and snapshot say. */
function describeScope(
  record: OperationJournalRecord,
  entry: StoredBackupIndexEntry | undefined,
): string {
  const metadata = record.metadata ?? {}
  for (const field of ['alias', 'scope', 'name'] as const) {
    const value = metadata[field]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const targets = entry?.targets ?? []
  const first = targets[0]
  if (first === undefined) return '(no restore point recorded)'
  if (targets.length === 1) return first.path
  return `${first.path} (+${targets.length - 1} more)`
}
