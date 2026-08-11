import { isGitXyConflict } from './status-codes.js'

/** One file entry parsed from `git status --porcelain=v1 -z` output. */
export interface GitFileStatus {
  /** Two-character porcelain XY status (e.g. `??`, ` M`, `MM`, `UU`). */
  xy: string
  /** Destination path for renames/copies, otherwise the changed path. */
  path: string
  /** Source path for renames (`R`) and copies (`C`). */
  originalPath?: string
  /** Whether the change is staged (index column holds a change). */
  staged: boolean
  /** Whether the worktree differs from the index. */
  unstaged: boolean
  /** Whether the file is untracked (`??`). */
  untracked: boolean
  /** Whether this entry represents a merge conflict (`UU`/`AA`/`DD`/...). */
  conflict: boolean
}

/**
 * Parses `git status --porcelain=v1 -z` output into structured entries.
 *
 * Rename/copy records span two NUL-separated records in `-z` mode: the first
 * carries the XY code and the source path, the second the destination path.
 * Conflicts (either column `U`) are flagged so callers can gate on them.
 */
export function parsePorcelainStatus(stdout: string): GitFileStatus[] {
  const records = stdout.split('\0')
  const files: GitFileStatus[] = []

  let index = 0
  while (index < records.length) {
    const record = records[index]
    index += 1
    if (record === undefined) {
      continue
    }
    // `--porcelain=v1` emits no header, so every record is `XY <path>`.
    if (record.length < 4) {
      continue
    }
    const xy = record.slice(0, 2)
    let path = record.slice(3)

    let originalPath: string | undefined
    if (xy[0] === 'R' || xy[0] === 'C') {
      originalPath = path
      const next = records[index]
      index += 1
      if (next !== undefined && next.length > 0) {
        path = next
      }
    }

    files.push({
      xy,
      path,
      ...(originalPath !== undefined ? { originalPath } : {}),
      staged: xy[0] !== ' ' && xy[0] !== '?',
      unstaged: xy[1] !== ' ' && xy[1] !== '?',
      untracked: xy === '??',
      conflict: isGitXyConflict(xy),
    })
  }

  return files
}

/** Filters conflicting entries out of a parsed status list. */
export function conflictsOf(files: GitFileStatus[]): GitFileStatus[] {
  return files.filter((file) => file.conflict)
}
