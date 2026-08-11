/**
 * M20.5/6/7 Merge state persistence + M20.8 pre-merge backup.
 *
 * An in-flight merge is recorded under `<home>/state/merge/<alias>/`:
 * - `state.json` — the merge record (revisions, conflict files),
 * - `base/` — the base snapshot,
 * - `local/` — the pre-merge local content (what `abortMerge` restores),
 * - `upstream/` — the merged-from upstream content.
 *
 * A pre-merge backup is additionally kept at `<home>/backups/<alias>-<ts>/`
 * (survives `continueMerge`, unlike the state directory).
 */
import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import { validateRelativePath } from '../fs/paths.js'
import type { SkillMode } from '../domain/skill.js'
import { scanSkillDirectory } from '../fs/scanner.js'

export const MERGE_STATE_VERSION = 1 as const

export interface MergeStateRecord {
  version: typeof MERGE_STATE_VERSION
  alias: string
  mode: SkillMode
  startedAt: string
  baseRevision: string
  latestRevision: string
  /** Conflict files, each with its hunk count (for `--continue` reporting). */
  conflictFiles: Array<{ path: string; hunks: number }>
}

export interface MergeStatePaths {
  /** `<home>/state/merge/<alias>` */
  root: string
  stateFile: string
  baseDir: string
  localDir: string
  upstreamDir: string
}

export function mergeStateRoot(homeRoot: string): string {
  return path.join(homeRoot, 'state', 'merge')
}

/** Storage locations for one alias' in-flight merge. */
export function mergeStatePaths(homeRoot: string, alias: string): MergeStatePaths {
  const safeAlias = validateRelativePath(alias)
  const root = path.join(mergeStateRoot(homeRoot), safeAlias)
  return {
    root,
    stateFile: path.join(root, 'state.json'),
    baseDir: path.join(root, 'base'),
    localDir: path.join(root, 'local'),
    upstreamDir: path.join(root, 'upstream'),
  }
}

/** True when a merge is in flight for `alias` (conflict state). */
export async function hasPendingMerge(
  homeRoot: string,
  alias: string,
  filesystem?: FilesystemService,
): Promise<boolean> {
  const fsService = filesystem ?? new FilesystemService()
  return fsService.exists(mergeStatePaths(homeRoot, alias).stateFile)
}

/**
 * Persists an in-flight merge: copies the three content views under
 * `<home>/state/merge/<alias>/` and writes `state.json`.
 */
export async function saveMergeState(input: {
  homeRoot: string
  alias: string
  mode: SkillMode
  baseRevision: string
  latestRevision: string
  conflictFiles: Array<{ path: string; hunks: number }>
  baseDir: string
  localDir: string
  upstreamDir: string
  filesystem?: FilesystemService
}): Promise<MergeStatePaths> {
  const fsService = input.filesystem ?? new FilesystemService()
  const paths = mergeStatePaths(input.homeRoot, input.alias)
  await fsService.mkdir(paths.root)
  await Promise.all([
    copyInto(paths.baseDir, input.baseDir, fsService),
    copyInto(paths.localDir, input.localDir, fsService),
    copyInto(paths.upstreamDir, input.upstreamDir, fsService),
  ])
  const record: MergeStateRecord = {
    version: MERGE_STATE_VERSION,
    alias: input.alias,
    mode: input.mode,
    startedAt: new Date().toISOString(),
    baseRevision: input.baseRevision,
    latestRevision: input.latestRevision,
    conflictFiles: input.conflictFiles.map((entry) => ({ ...entry })),
  }
  await fsService.writeFile(paths.stateFile, JSON.stringify(record, null, 2))
  return paths
}

/** Loads the in-flight merge record for `alias`, or `undefined`. */
export async function loadMergeState(
  homeRoot: string,
  alias: string,
  filesystem?: FilesystemService,
): Promise<MergeStateRecord | undefined> {
  const fsService = filesystem ?? new FilesystemService()
  const paths = mergeStatePaths(homeRoot, alias)
  if (!(await fsService.exists(paths.stateFile))) {
    return undefined
  }
  let raw: string
  try {
    raw = await fsService.readFile(paths.stateFile)
  } catch (error) {
    throw invalidState(paths.stateFile, error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw invalidState(paths.stateFile, error)
  }
  if (!isMergeStateRecord(parsed)) {
    throw invalidState(paths.stateFile, undefined)
  }
  return parsed
}

/** Removes the in-flight merge state for `alias`. */
export async function removeMergeState(
  homeRoot: string,
  alias: string,
  filesystem?: FilesystemService,
): Promise<void> {
  const fsService = filesystem ?? new FilesystemService()
  const paths = mergeStatePaths(homeRoot, alias)
  await fsService.remove(paths.root)
}

function invalidState(stateFile: string, cause: unknown): SkillboxError {
  return new SkillboxError(
    ErrorCode.MERGE_INVALID_STATE,
    `Merge state file "${stateFile}" is corrupted`,
    { cause, context: { stateFile } },
  )
}

function isMergeStateRecord(value: unknown): value is MergeStateRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    record['version'] === MERGE_STATE_VERSION &&
    typeof record['alias'] === 'string' &&
    typeof record['mode'] === 'string' &&
    typeof record['startedAt'] === 'string' &&
    typeof record['baseRevision'] === 'string' &&
    typeof record['latestRevision'] === 'string' &&
    Array.isArray(record['conflictFiles']) &&
    record['conflictFiles'].every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['path'] === 'string' &&
        typeof (entry as Record<string, unknown>)['hunks'] === 'number',
    )
  )
}

async function copyInto(
  destination: string,
  source: string,
  fsService: FilesystemService,
): Promise<void> {
  if (await fsService.exists(destination)) {
    await fsService.remove(destination)
  }
  await fsService.mkdir(path.dirname(destination))
  await fsService.copy(source, destination)
}

/* ------------------------------------------------------------------ *
 * M20.8 pre-merge backups
 * ------------------------------------------------------------------ */

export function backupRoot(homeRoot: string): string {
  return path.join(homeRoot, 'backups')
}

/** Timestamp-safe directory name: `<alias>-<ISO-8601 with : and . replaced>`. */
export function backupDirFor(
  homeRoot: string,
  alias: string,
  timestamp: Date = new Date(),
): string {
  const safeAlias = validateRelativePath(alias)
  const stamp = timestamp.toISOString().replace(/[:.]/g, '-')
  return path.join(backupRoot(homeRoot), `${safeAlias}-${stamp}`)
}

/** Copies the current local content into a timestamped backup directory. */
export async function createBackup(input: {
  homeRoot: string
  alias: string
  localDir: string
  filesystem?: FilesystemService
}): Promise<string> {
  const fsService = input.filesystem ?? new FilesystemService()
  const backupDir = backupDirFor(input.homeRoot, input.alias)
  await copyInto(backupDir, input.localDir, fsService)
  return backupDir
}

/** Number of files in a directory tree (for `abortMerge` reporting). */
export async function countFilesIn(dir: string): Promise<number> {
  const scan = await scanSkillDirectory(dir)
  return scan.files.length
}
