import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { ErrorCode, SkillboxError } from '../errors.js'

/**
 * Repository-relative root of the Fork Base Snapshots (SPEC §58-60):
 * `.skillbox/bases/<alias>/<revision>/`. Kept inside the repository so git
 * tracks it; outside `skills/` so users never browse it directly.
 */
export const BASES_DIR_RELATIVE = '.skillbox/bases'

/** Absolute root of every Base Snapshot under `repositoryRoot`. */
export function baseSnapshotRoot(repositoryRoot: string): string {
  return path.join(path.resolve(repositoryRoot), '.skillbox', 'bases')
}

/** Absolute path of `.skillbox/bases/<alias>/<revision>` (never escapes the repo). */
export function baseSnapshotDir(repositoryRoot: string, alias: string, revision: string): string {
  return resolveInsideRoot(repositoryRoot, `${BASES_DIR_RELATIVE}/${alias}/${revision}`)
}

export interface SaveBaseSnapshotInput {
  repositoryRoot: string
  alias: string
  /** Revision used as the directory name (`baseRevision` of the fork). */
  revision: string
  /** Directory whose content is snapshotted (the managed runtime copy). */
  source: string
  filesystem?: FilesystemService
}

/**
 * Copies `source` into `.skillbox/bases/<alias>/<revision>/` (M17.4). The
 * snapshot is an independent copy so a later upstream force-push or repo
 * removal cannot destroy the 3-way merge base (SPEC §55-58).
 */
export async function saveBaseSnapshot(input: SaveBaseSnapshotInput): Promise<string> {
  const filesystem = input.filesystem ?? new FilesystemService()
  const target = baseSnapshotDir(input.repositoryRoot, input.alias, input.revision)
  try {
    await filesystem.mkdir(path.dirname(target))
    await filesystem.copy(input.source, target)
  } catch (error) {
    throw new SkillboxError(
      ErrorCode.LIFECYCLE_BASE_SNAPSHOT_FAILED,
      `Failed to save the base snapshot of "${input.alias}" to "${target}"`,
      {
        cause: error,
        context: { alias: input.alias, revision: input.revision, target },
      },
    )
  }
  return target
}

export interface RemoveBaseSnapshotInput {
  repositoryRoot: string
  alias: string
  /** When omitted, the whole `.skillbox/bases/<alias>/` tree is removed. */
  revision?: string
  filesystem?: FilesystemService
}

/**
 * Deletes the saved Base Snapshot. Without `revision` the entire
 * `.skillbox/bases/<alias>/` tree is removed (used by Forked → Vendored,
 * M18.2). Returns the removed directory, or `undefined` when nothing existed.
 */
export async function removeBaseSnapshot(
  input: RemoveBaseSnapshotInput,
): Promise<string | undefined> {
  const filesystem = input.filesystem ?? new FilesystemService()
  const root = baseSnapshotRoot(input.repositoryRoot)
  const target =
    input.revision === undefined
      ? path.join(root, input.alias)
      : path.join(root, input.alias, input.revision)
  if (!(await filesystem.exists(target))) {
    return undefined
  }
  await filesystem.remove(target)
  return target
}
