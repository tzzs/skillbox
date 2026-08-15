/**
 * Backup domain types (roadmap 2.4 / GAP §3.3): every recoverable mutation
 * records a backup entry in `~/.skillbox/state/backups/index.json` pointing at
 * an independent copy of the pre-mutation content.
 */

export const BACKUP_INDEX_VERSION = 1 as const

/** What a backup contains (decides how rollback restores it). */
export type BackupKind = 'runtime' | 'repo-dir'

export interface BackupRecord {
  /** Stable id (`<operation>-<alias>-<timestamp>`), also the backup dir name. */
  id: string
  kind: BackupKind
  /** Producing operation, e.g. `restore` | `remove`. */
  operation: string
  /** Skill alias the backup belongs to. */
  alias: string
  /** ISO timestamp when the backup was taken. */
  createdAt: string
  /** Absolute path of the backup directory (independent copy). */
  path: string
  /** Absolute path that was backed up — the restore target. */
  sourcePath: string
  /** Repository the backup belongs to (cross-repo rollback is refused). */
  repositoryRoot: string
}

export interface BackupIndex {
  version: typeof BACKUP_INDEX_VERSION
  backups: BackupRecord[]
}

export interface RollbackResult {
  id: string
  kind: BackupKind
  operation: string
  alias: string
  /** Files restored from the backup into the source location. */
  filesRestored: number
  /** Absolute path that was restored (the source path). */
  path: string
}

/** Retention default: backups kept per operation+alias key. */
export const DEFAULT_KEEP_BACKUPS_PER_KEY = 10
