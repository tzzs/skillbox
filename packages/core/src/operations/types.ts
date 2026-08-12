/** Supported repository mutations. `custom` keeps the runtime forward compatible. */
export type OperationKind =
  | 'install'
  | 'sync'
  | 'add'
  | 'update'
  | 'fork'
  | 'vendor'
  | 'restore'
  | 'merge'
  | 'remove'
  | 'migrate'
  | 'custom'

/** Ordered mutation milestones shared by runtime, snapshots, and rollback. */
export type OperationPhase =
  | 'prepared'
  | 'snapshot-created'
  | 'mutating'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'failed'

/** Injectable wall clock used to make expiry and journal timestamps deterministic. */
export interface OperationClock {
  now(): number
}

export const systemOperationClock: OperationClock = { now: () => Date.now() }

/** Identifies the process which owns an exclusive repository mutation lock. */
export interface OperationOwner {
  id: string
  pid: number
  hostname?: string
}

/** A filesystem location captured before an operation changes it. */
export interface SnapshotTarget {
  path: string
  kind: 'file' | 'directory' | 'absent'
}

/** Metadata required to locate and validate a restorable operation snapshot. */
export interface BackupIndexEntry {
  operationId: string
  repositoryKey: string
  snapshotId: string
  createdAt: string
  expiresAt?: string
  targets: SnapshotTarget[]
}

export type OperationJournalStatus =
  'running' | 'completed' | 'failed' | 'rolled-back' | 'abandoned'

export const TERMINAL_OPERATION_JOURNAL_STATUSES = new Set<OperationJournalStatus>([
  'completed',
  'failed',
  'rolled-back',
  'abandoned',
])

export function isTerminalOperationJournalStatus(status: OperationJournalStatus): boolean {
  return TERMINAL_OPERATION_JOURNAL_STATUSES.has(status)
}

/**
 * Persisted, versioned operation state. The record is deliberately JSON-only
 * so interrupted writes can be recovered without loading implementation code.
 */
export interface OperationJournalRecord {
  version: 1
  operationId: string
  repositoryKey: string
  kind: OperationKind
  owner: OperationOwner
  status: OperationJournalStatus
  stage: string
  startedAt: string
  updatedAt: string
  metadata?: Record<string, unknown>
  error?: { message: string; code?: string }
}

/**
 * Runtime-facing operation shape. The journal may add its durable status and
 * timestamps, while snapshot/backup modules can depend on this stable core.
 */
export interface OperationRecord {
  operationId: string
  repositoryKey: string
  kind: OperationKind
  owner: OperationOwner
  phase: OperationPhase
  snapshot?: BackupIndexEntry
}
