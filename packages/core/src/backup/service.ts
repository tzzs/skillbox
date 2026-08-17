import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { scanSkillDirectory } from '../fs/scanner.js'
import { ErrorCode, SkillboxError } from '../errors.js'
import { DEFAULT_KEEP_BACKUPS_PER_KEY, BACKUP_INDEX_VERSION } from './types.js'
import type { BackupIndex, BackupKind, BackupRecord, RollbackResult } from './types.js'

export interface BackupServiceOptions {
  /** Skillbox home root; the index lives under `<home>/state/backups/`. */
  homeRoot: string
  filesystem?: FilesystemService
  /** Backups kept per operation+alias key (older ones are pruned). */
  keepPerKey?: number
  now?: () => Date
}

/** `state/backups/` — the unified backup store (roadmap 2.4). */
export function backupStoreRoot(homeRoot: string): string {
  return path.join(homeRoot, 'state', 'backups')
}

/** Absolute path of one backup directory (`state/backups/<id>`). */
export function backupDir(homeRoot: string, id: string): string {
  return path.join(backupStoreRoot(homeRoot), id)
}

function indexFilePath(homeRoot: string): string {
  return path.join(backupStoreRoot(homeRoot), 'index.json')
}

/**
 * Unified backup service (roadmap 2.4 / GAP §3.3):
 *
 * - `record()` indexes an independent backup copy (created by the mutation
 *   transaction) and enforces the retention policy (keeps the newest
 *   `keepPerKey` backups per operation+alias, prunes the rest).
 * - `rollback()` restores one backup onto its source path, refusing records
 *   that are missing (`BACKUP_INCOMPLETE`), unknown (`BACKUP_NOT_FOUND`) or
 *   belong to another repository (`BACKUP_REPOSITORY_MISMATCH`).
 *
 * The index is disposable bookkeeping: a deleted index only loses the
 * rollback mapping, never skill content.
 */
export class BackupService {
  private readonly homeRoot: string
  private readonly filesystem: FilesystemService
  private readonly keepPerKey: number
  private readonly now: () => Date

  constructor(options: BackupServiceOptions) {
    this.homeRoot = path.resolve(options.homeRoot)
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.keepPerKey = options.keepPerKey ?? DEFAULT_KEEP_BACKUPS_PER_KEY
    this.now = options.now ?? (() => new Date())
  }

  async loadIndex(): Promise<BackupIndex> {
    const filePath = indexFilePath(this.homeRoot)
    if (!(await this.filesystem.exists(filePath))) {
      return { version: BACKUP_INDEX_VERSION, backups: [] }
    }
    let document: unknown
    try {
      document = JSON.parse(await this.filesystem.readFile(filePath))
    } catch {
      // A corrupt index is disposable — rollback mappings are lost, content stays.
      return { version: BACKUP_INDEX_VERSION, backups: [] }
    }
    const index = document as Partial<BackupIndex> | null
    if (index === null || !Array.isArray(index.backups)) {
      return { version: BACKUP_INDEX_VERSION, backups: [] }
    }
    const valid = index.backups.filter(
      (record): record is BackupRecord =>
        typeof record === 'object' &&
        record !== null &&
        typeof record.id === 'string' &&
        typeof record.kind === 'string' &&
        typeof record.operation === 'string' &&
        typeof record.alias === 'string' &&
        typeof record.createdAt === 'string' &&
        typeof record.path === 'string' &&
        typeof record.sourcePath === 'string' &&
        typeof record.repositoryRoot === 'string',
    )
    return { version: BACKUP_INDEX_VERSION, backups: valid }
  }

  async saveIndex(index: BackupIndex): Promise<void> {
    const filePath = indexFilePath(this.homeRoot)
    await this.filesystem.mkdir(path.dirname(filePath))
    await this.filesystem.writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`)
  }

  /**
   * Indexes an existing backup directory and enforces retention. The caller
   * (the mutation transaction) created `input.path`; an already-indexed id is
   * replaced (idempotent re-record).
   */
  async record(input: {
    id: string
    kind: BackupKind
    operation: string
    alias: string
    path: string
    sourcePath: string
    repositoryRoot: string
    metadata?: BackupRecord['metadata']
  }): Promise<BackupRecord> {
    if (!(await this.filesystem.exists(input.path))) {
      throw new SkillboxError(
        ErrorCode.BACKUP_INCOMPLETE,
        `Cannot index backup "${input.id}": content is missing at "${input.path}"`,
        { context: { id: input.id, path: input.path } },
      )
    }
    const record: BackupRecord = {
      id: input.id,
      kind: input.kind,
      operation: input.operation,
      alias: input.alias,
      createdAt: this.now().toISOString(),
      path: path.resolve(input.path),
      sourcePath: path.resolve(input.sourcePath),
      repositoryRoot: path.resolve(input.repositoryRoot),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    }
    const index = await this.loadIndex()
    const rest = index.backups.filter((existing) => existing.id !== record.id)
    index.backups = [...rest, record]
    await this.saveIndex(index)
    await this.prune()
    return record
  }

  /** Creates a manifest/lockfile snapshot before a repository mutation. */
  async snapshotMetadata(input: {
    id: string
    operation: string
    repositoryRoot: string
    manifestPath: string
    lockfilePath: string
    alias?: string
  }): Promise<BackupRecord> {
    const snapshot = backupDir(this.homeRoot, input.id)
    await this.filesystem.remove(snapshot)
    await this.filesystem.mkdir(snapshot)
    const manifestExists = await this.filesystem.exists(input.manifestPath)
    const lockfileExists = await this.filesystem.exists(input.lockfilePath)
    if (manifestExists)
      await this.filesystem.copy(input.manifestPath, path.join(snapshot, 'skillbox.yaml'))
    if (lockfileExists)
      await this.filesystem.copy(input.lockfilePath, path.join(snapshot, 'skillbox.lock'))
    return this.record({
      id: input.id,
      kind: 'repo-metadata',
      operation: input.operation,
      alias: input.alias ?? '*',
      path: snapshot,
      sourcePath: input.repositoryRoot,
      repositoryRoot: input.repositoryRoot,
      metadata: {
        manifestPath: input.manifestPath,
        lockfilePath: input.lockfilePath,
        manifestExists,
        lockfileExists,
      },
    })
  }

  /** Removes an index entry without touching its content (transaction rollback). */
  async forget(id: string): Promise<boolean> {
    const index = await this.loadIndex()
    const next = index.backups.filter((record) => record.id !== id)
    if (next.length === index.backups.length) {
      return false
    }
    index.backups = next
    await this.saveIndex(index)
    return true
  }

  /** All backups, newest first. */
  async list(): Promise<BackupRecord[]> {
    const index = await this.loadIndex()
    return [...index.backups].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async get(id: string): Promise<BackupRecord | undefined> {
    const index = await this.loadIndex()
    return index.backups.find((record) => record.id === id)
  }

  /**
   * Restores one backup onto its source path (runtime library copy or
   * repository directory). Refuses unknown / incomplete / cross-repository
   * records.
   */
  async rollback(id: string, options: { repositoryRoot: string }): Promise<RollbackResult> {
    const record = await this.get(id)
    if (record === undefined) {
      throw new SkillboxError(ErrorCode.BACKUP_NOT_FOUND, `No backup with id "${id}"`, {
        context: { id },
      })
    }
    if (path.resolve(record.repositoryRoot) !== path.resolve(options.repositoryRoot)) {
      throw new SkillboxError(
        ErrorCode.BACKUP_REPOSITORY_MISMATCH,
        `Backup "${id}" belongs to repository "${record.repositoryRoot}", not "${options.repositoryRoot}"`,
        { context: { id, backup: record.repositoryRoot, current: options.repositoryRoot } },
      )
    }
    if (!(await this.filesystem.exists(record.path))) {
      throw new SkillboxError(
        ErrorCode.BACKUP_INCOMPLETE,
        `Backup "${id}" content is missing at "${record.path}"`,
        { context: { id, path: record.path } },
      )
    }
    try {
      if (record.kind === 'repo-metadata' && record.metadata !== undefined) {
        const manifestBackup = path.join(record.path, 'skillbox.yaml')
        const lockfileBackup = path.join(record.path, 'skillbox.lock')
        await this.restoreOptionalFile(
          manifestBackup,
          record.metadata.manifestPath,
          record.metadata.manifestExists,
        )
        await this.restoreOptionalFile(
          lockfileBackup,
          record.metadata.lockfilePath,
          record.metadata.lockfileExists,
        )
      } else {
        if (await this.filesystem.exists(record.sourcePath)) {
          await this.filesystem.remove(record.sourcePath)
        }
        await this.filesystem.mkdir(path.dirname(record.sourcePath))
        await this.filesystem.copy(record.path, record.sourcePath)
      }
    } catch (error) {
      throw new SkillboxError(
        ErrorCode.ROLLBACK_FAILED,
        `Failed to restore backup "${id}" onto "${record.sourcePath}"`,
        { cause: error, context: { id, path: record.path, source: record.sourcePath } },
      )
    }
    const scan = await scanSkillDirectory(record.path)
    return {
      id: record.id,
      kind: record.kind,
      operation: record.operation,
      alias: record.alias,
      filesRestored: scan.files.length,
      path: record.sourcePath,
    }
  }

  private async restoreOptionalFile(
    backup: string,
    target: string,
    existed: boolean,
  ): Promise<void> {
    if (existed) {
      if (!(await this.filesystem.exists(backup)))
        throw new SkillboxError(
          ErrorCode.BACKUP_INCOMPLETE,
          `Metadata snapshot is missing at "${backup}"`,
        )
      await this.filesystem.mkdir(path.dirname(target))
      await this.filesystem.writeFile(target, await this.filesystem.readFile(backup))
    } else if (await this.filesystem.exists(target)) {
      await this.filesystem.remove(target)
    }
  }

  /**
   * Retention: keeps the newest `keepPerKey` backups per operation+alias key
   * and deletes the rest (index entries + content). Returns the number of
   * pruned backups.
   */
  async prune(keepPerKey: number = this.keepPerKey): Promise<number> {
    const index = await this.loadIndex()
    const byKey = new Map<string, BackupRecord[]>()
    for (const record of index.backups) {
      const key = `${record.operation}:${record.alias}`
      const list = byKey.get(key) ?? []
      list.push(record)
      byKey.set(key, list)
    }
    const kept: BackupRecord[] = []
    let pruned = 0
    for (const list of byKey.values()) {
      const sorted = [...list].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      for (const record of sorted.slice(0, keepPerKey)) {
        kept.push(record)
      }
      for (const record of sorted.slice(keepPerKey)) {
        pruned += 1
        await this.filesystem.remove(record.path).catch(() => undefined)
      }
    }
    if (pruned > 0) {
      index.backups = kept
      await this.saveIndex(index)
    }
    return pruned
  }
}
