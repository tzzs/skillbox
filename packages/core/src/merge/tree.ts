/**
 * M20.2 File Tree Merge + M20.3 Binary handling.
 *
 * Tree-level 3-way merge rules over three skill trees (base / local /
 * upstream):
 * - added on one side only → included; added on both sides identically →
 *   included once; added on both sides differently → conflict.
 * - deleted on both sides → deleted.
 * - deleted on one side, unchanged on the other → deleted.
 * - deleted on one side, changed on the other → conflict.
 * - changed identically on both sides → auto-resolved.
 * - changed on both sides, non-overlapping → merged; overlapping → conflict.
 * - binary files changed on both sides cannot be auto-merged: with the
 *   default `fail` policy the merge refuses and throws `MERGE_BINARY_CONFLICT`
 *   carrying `keepLocal` / `useUpstream` resolution options; with
 *   `keepLocal` / `useUpstream` the named side wins.
 */
import { SkillboxError, ErrorCode } from '../errors.js'
import { mergeTexts, type MergeConflict } from './merge.js'
import { entryText, entriesEqual, isBinaryContent, type TreeEntry } from '../diff/sources.js'

export type BinaryMergePolicy = 'fail' | 'keepLocal' | 'useUpstream'

/** One file-level text conflict of a tree merge. */
export interface TreeFileConflict {
  /** Portable relative path (forward slashes). */
  path: string
  /** Merged text with conflict markers embedded. */
  merged: string
  /** Conflict hunks within this file. */
  hunks: MergeConflict[]
}

/** One binary file changed on both sides (resolved by policy or refused). */
export interface TreeBinaryConflict {
  path: string
  /** Local bytes (kept with `keepLocal`). */
  localBytes: Buffer
  /** Upstream bytes (kept with `useUpstream`). */
  upstreamBytes: Buffer
}

export interface TreeMergeOptions {
  /** Binary handling (default `fail`: throw `MERGE_BINARY_CONFLICT`). */
  binary?: BinaryMergePolicy
}

export interface TreeMergeResult {
  /** Merged tree (conflict files carry marker text). */
  files: TreeEntry[]
  conflicts: TreeFileConflict[]
  /** Binary files resolved by policy (empty with `fail`). */
  binaryConflicts: TreeBinaryConflict[]
  /** Number of files that changed relative to local. */
  changedCount: number
}

function copyEntry(entry: TreeEntry, pathOverride?: string): TreeEntry {
  const copy: TreeEntry = {
    path: pathOverride ?? entry.path,
    kind: entry.kind,
    bytes: Buffer.from(entry.bytes),
  }
  if (entry.symlinkTarget !== undefined) {
    copy.symlinkTarget = entry.symlinkTarget
  }
  return copy
}

/**
 * M20.2 `mergeTrees()`: applies the file-tree merge rules over three in-memory
 * trees. Pure — never touches the filesystem.
 */
export function mergeTrees(
  base: Map<string, TreeEntry>,
  local: Map<string, TreeEntry>,
  upstream: Map<string, TreeEntry>,
  options: TreeMergeOptions = {},
): TreeMergeResult {
  const binaryPolicy = options.binary ?? 'fail'
  const paths = new Set<string>([...base.keys(), ...local.keys(), ...upstream.keys()])
  const files: TreeEntry[] = []
  const conflicts: TreeFileConflict[] = []
  const binaryConflicts: TreeBinaryConflict[] = []
  let changed = 0

  for (const filePath of [...paths].sort()) {
    const baseEntry = base.get(filePath)
    const localEntry = local.get(filePath)
    const upstreamEntry = upstream.get(filePath)

    if (baseEntry === undefined) {
      // Added by one or both sides.
      if (localEntry === undefined && upstreamEntry !== undefined) {
        mergeOne(filePath, upstreamEntry)
        changed++
      } else if (upstreamEntry === undefined && localEntry !== undefined) {
        mergeOne(filePath, localEntry)
        changed++
      } else if (localEntry !== undefined && upstreamEntry !== undefined) {
        if (entriesEqual(localEntry, upstreamEntry)) {
          mergeOne(filePath, localEntry)
          changed++
        } else if (isBinaryContent(localEntry.bytes) || isBinaryContent(upstreamEntry.bytes)) {
          resolveBinary(filePath, localEntry, upstreamEntry)
        } else {
          // Both added the same path with different content → conflict.
          const merged = mergeTexts('', entryText(localEntry), entryText(upstreamEntry))
          files.push(conflictEntry(filePath, merged.mergedText))
          conflicts.push({ path: filePath, merged: merged.mergedText, hunks: merged.conflicts })
          changed++
        }
      }
      continue
    }

    // baseEntry is defined.
    if (localEntry === undefined && upstreamEntry === undefined) {
      // Deleted by both sides → deleted.
      changed++
      continue
    }
    if (upstreamEntry === undefined) {
      // Upstream deleted; local kept.
      if (entriesEqual(localEntry!, baseEntry)) {
        changed++ // deletion wins (local unchanged)
        continue
      }
      // Upstream deleted, local changed → conflict.
      pushDeleteModifyConflict(filePath, baseEntry, localEntry!, 'local')
      changed++
      continue
    }
    if (localEntry === undefined) {
      // Local deleted; upstream kept (base). The both-deleted case was
      // handled above, so `upstreamEntry` is defined here.
      if (entriesEqual(upstreamEntry, baseEntry)) {
        changed++ // deletion wins (upstream unchanged)
        continue
      }
      // Local deleted, upstream changed → conflict.
      pushDeleteModifyConflict(filePath, baseEntry, upstreamEntry, 'upstream')
      changed++
      continue
    }

    // All three present.
    if (entriesEqual(localEntry, baseEntry) && entriesEqual(upstreamEntry, baseEntry)) {
      mergeOne(filePath, baseEntry) // unchanged
      continue
    }
    if (entriesEqual(localEntry, upstreamEntry)) {
      mergeOne(filePath, localEntry) // identical change on both sides
      changed++
      continue
    }
    if (entriesEqual(localEntry, baseEntry)) {
      mergeOne(filePath, upstreamEntry) // only upstream changed
      changed++
      continue
    }
    if (entriesEqual(upstreamEntry, baseEntry)) {
      mergeOne(filePath, localEntry) // only local changed
      changed++
      continue
    }
    // Both changed.
    if (isBinaryContent(localEntry.bytes) || isBinaryContent(upstreamEntry.bytes)) {
      resolveBinary(filePath, localEntry, upstreamEntry)
      continue
    }
    const merged = mergeTexts(entryText(baseEntry), entryText(localEntry), entryText(upstreamEntry))
    if (merged.conflicts.length > 0) {
      files.push(conflictEntry(filePath, merged.mergedText))
      conflicts.push({ path: filePath, merged: merged.mergedText, hunks: merged.conflicts })
    } else {
      files.push({ path: filePath, kind: 'file', bytes: Buffer.from(merged.mergedText, 'utf8') })
    }
    changed++
  }

  return { files, conflicts, binaryConflicts, changedCount: changed }

  /** Pushes one result entry under the current loop path. */
  function mergeOne(filePath: string, entry: TreeEntry): void {
    files.push(copyEntry(entry, filePath))
  }

  function resolveBinary(filePath: string, localEntry: TreeEntry, upstreamEntry: TreeEntry): void {
    if (binaryPolicy === 'fail') {
      throw new SkillboxError(
        ErrorCode.MERGE_BINARY_CONFLICT,
        `Cannot auto-merge binary file "${filePath}" — changed on both sides`,
        {
          context: {
            file: filePath,
            // Resolution options for the caller.
            keepLocal: { file: filePath, policy: 'keepLocal' },
            useUpstream: { file: filePath, policy: 'useUpstream' },
          },
        },
      )
    }
    const chosen = binaryPolicy === 'keepLocal' ? localEntry : upstreamEntry
    mergeOne(filePath, chosen)
    changed++
    binaryConflicts.push({
      path: filePath,
      localBytes: Buffer.from(localEntry.bytes),
      upstreamBytes: Buffer.from(upstreamEntry.bytes),
    })
  }

  function pushDeleteModifyConflict(
    filePath: string,
    baseEntry: TreeEntry,
    changedEntry: TreeEntry,
    changedSide: 'local' | 'upstream',
  ): void {
    const deleted = entryText(baseEntry)
    const kept = entryText(changedEntry)
    const merged =
      changedSide === 'local' ? mergeTexts(deleted, kept, '') : mergeTexts(deleted, '', kept)
    files.push(conflictEntry(filePath, merged.mergedText))
    conflicts.push({ path: filePath, merged: merged.mergedText, hunks: merged.conflicts })
  }
}

function conflictEntry(filePath: string, merged: string): TreeEntry {
  return { path: filePath, kind: 'file', bytes: Buffer.from(merged, 'utf8') }
}
