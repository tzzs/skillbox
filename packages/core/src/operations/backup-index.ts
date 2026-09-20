import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import type { BackupIndexEntry } from './types.js'

export interface StoredBackupIndexEntry extends BackupIndexEntry {
  state: 'active' | 'completed'
  completedAt?: string
  snapshotPaths: string[]
}

interface BackupIndexDocument {
  version: 1
  entries: StoredBackupIndexEntry[]
}

/** Small durable index of operation backups. Active records are never pruned. */
export class BackupIndexStore {
  constructor(
    private readonly indexPath: string,
    private readonly filesystem: FilesystemService = new FilesystemService(),
  ) {}

  async add(entry: StoredBackupIndexEntry): Promise<void> {
    assertEntry(entry)
    const document = await this.readDocument()
    if (document.entries.some((existing) => existing.operationId === entry.operationId)) {
      throw rollbackInvalid(`Backup operation "${entry.operationId}" already exists`)
    }
    document.entries.push(copyEntry(entry))
    await this.writeDocument(document)
  }

  async list(): Promise<StoredBackupIndexEntry[]> {
    return (await this.readDocument()).entries.map(copyEntry)
  }

  async markCompleted(operationId: string, completedAt = new Date().toISOString()): Promise<void> {
    const document = await this.readDocument()
    const entry = document.entries.find((candidate) => candidate.operationId === operationId)
    if (entry === undefined)
      throw new SkillboxError(
        ErrorCode.OPERATION_BACKUP_NOT_FOUND,
        `Backup "${operationId}" was not found`,
      )
    entry.state = 'completed'
    entry.completedAt = completedAt
    await this.writeDocument(document)
  }

  async requireCompleted(
    operationId: string,
    repositoryKey: string,
    now: Date = new Date(),
  ): Promise<StoredBackupIndexEntry> {
    assertRepositoryKey(repositoryKey)
    const entry = (await this.readDocument()).entries.find(
      (item) => item.operationId === operationId,
    )
    if (entry === undefined)
      throw new SkillboxError(
        ErrorCode.OPERATION_BACKUP_NOT_FOUND,
        `Backup "${operationId}" was not found`,
      )
    if (entry.repositoryKey !== repositoryKey) {
      throw new SkillboxError(
        ErrorCode.OPERATION_ROLLBACK_REPOSITORY_MISMATCH,
        'Backup belongs to a different repository',
      )
    }
    if (entry.state !== 'completed' || entry.completedAt === undefined) {
      throw rollbackInvalid(`Backup "${operationId}" is not completed`)
    }
    if (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now.getTime()) {
      throw new SkillboxError(
        ErrorCode.OPERATION_ROLLBACK_EXPIRED,
        `Backup "${operationId}" has expired`,
      )
    }
    return copyEntry(entry)
  }

  /** Removes expired entries and oldest completed entries beyond the retention limit. */
  async prune(options: { now?: Date; maxCompleted: number }): Promise<StoredBackupIndexEntry[]> {
    if (!Number.isInteger(options.maxCompleted) || options.maxCompleted < 0)
      throw new RangeError('maxCompleted must be a non-negative integer')
    const now = options.now ?? new Date()
    const document = await this.readDocument()
    const expired = new Set(
      document.entries
        .filter((entry) => entry.state === 'completed' && isExpired(entry, now))
        .map((entry) => entry.operationId),
    )
    const retainable = document.entries
      .filter((entry) => entry.state === 'completed' && !expired.has(entry.operationId))
      .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!))
    for (const entry of retainable.slice(options.maxCompleted)) expired.add(entry.operationId)
    const removed = document.entries
      .filter((entry) => expired.has(entry.operationId))
      .map(copyEntry)
    if (removed.length > 0) {
      document.entries = document.entries.filter((entry) => !expired.has(entry.operationId))
      await this.writeDocument(document)
    }
    return removed
  }

  private async readDocument(): Promise<BackupIndexDocument> {
    if (!(await this.filesystem.exists(this.indexPath))) return { version: 1, entries: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.filesystem.readFile(this.indexPath)) as unknown
    } catch (error) {
      throw rollbackInvalid(`Backup index "${this.indexPath}" is unreadable`, error)
    }
    if (!isDocument(parsed)) throw rollbackInvalid(`Backup index "${this.indexPath}" is invalid`)
    return parsed
  }

  private async writeDocument(document: BackupIndexDocument): Promise<void> {
    await atomicWriteFile(this.indexPath, `${JSON.stringify(document)}\n`)
  }
}

function isDocument(value: unknown): value is BackupIndexDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { entries?: unknown }).entries) &&
    (value as { entries: unknown[] }).entries.every(isEntry)
  )
}

function isEntry(value: unknown): value is StoredBackupIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  const state = entry['state']
  return (
    typeof entry['operationId'] === 'string' &&
    typeof entry['repositoryKey'] === 'string' &&
    typeof entry['snapshotId'] === 'string' &&
    typeof entry['createdAt'] === 'string' &&
    Array.isArray(entry['targets']) &&
    Array.isArray(entry['snapshotPaths']) &&
    (state === 'active' || state === 'completed') &&
    (entry['completedAt'] === undefined || typeof entry['completedAt'] === 'string') &&
    (entry['expiresAt'] === undefined || typeof entry['expiresAt'] === 'string') &&
    (state !== 'completed' || typeof entry['completedAt'] === 'string')
  )
}

function assertEntry(entry: StoredBackupIndexEntry): void {
  if (!isEntry(entry)) throw rollbackInvalid('Backup record is invalid')
  assertRepositoryKey(entry.repositoryKey)
  if (entry.state === 'completed' && entry.completedAt === undefined)
    throw rollbackInvalid('Completed backup must have completedAt')
  if (
    Number.isNaN(Date.parse(entry.createdAt)) ||
    (entry.completedAt !== undefined && Number.isNaN(Date.parse(entry.completedAt))) ||
    (entry.expiresAt !== undefined && Number.isNaN(Date.parse(entry.expiresAt)))
  )
    throw rollbackInvalid('Backup timestamps are invalid')
}

function assertRepositoryKey(repositoryKey: string): void {
  if (repositoryKey.trim() === '') throw rollbackInvalid('Backup repository key is invalid')
}

function isExpired(entry: StoredBackupIndexEntry, now: Date): boolean {
  return entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now.getTime()
}

function copyEntry(entry: StoredBackupIndexEntry): StoredBackupIndexEntry {
  return {
    ...entry,
    targets: entry.targets.map((target) => ({ ...target })),
    snapshotPaths: [...entry.snapshotPaths],
  }
}

function rollbackInvalid(message: string, cause?: unknown): SkillboxError {
  return new SkillboxError(ErrorCode.OPERATION_ROLLBACK_INVALID, message, { cause })
}
