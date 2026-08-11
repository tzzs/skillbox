/**
 * M20.1 3-way Text Merge — `mergeTexts(base, local, upstream)`.
 *
 * Both sides' diffs against the base are walked simultaneously (diff3
 * style). Non-overlapping changes merge cleanly; changes to the same region
 * (including both-added-different and delete-vs-modify) produce a conflict
 * hunk with git-style markers, unless both sides made the identical change
 * (auto-resolved).
 */
import { diffLineArrays, splitTextLines, type DiffLine } from '../diff/text.js'

export type MergedLineKind =
  'merged' | 'local' | 'upstream' | 'conflict-start' | 'conflict-separator' | 'conflict-end'

/** One line of the merged output. */
export interface MergedLine {
  kind: MergedLineKind
  text: string
  /** 1-based line number in the base (for `merged` lines). */
  baseLine?: number
  /** 1-based line number in the local side (for `local` lines). */
  localLine?: number
  /** 1-based line number in the upstream side (for `upstream` lines). */
  upstreamLine?: number
}

/** One conflict hunk of a merge. Line ranges are 1-based and inclusive. */
export interface MergeConflict {
  /** Local line range holding the conflicting change. */
  localStart: number
  localEnd: number
  /** Upstream line range holding the conflicting change. */
  upstreamStart: number
  upstreamEnd: number
  /** Merged-output line range covered by the conflict markers. */
  mergedStart: number
  mergedEnd: number
  localLines: string[]
  upstreamLines: string[]
}

export interface MergeTextOptions {
  /** Whether conflict markers are embedded in `mergedText` (default true). */
  conflictMarkers?: boolean
}

export interface MergeResult {
  /** False when at least one conflict hunk was produced. */
  ok: boolean
  mergedText: string
  conflicts: MergeConflict[]
  lines: MergedLine[]
}

/** A contiguous changed region in one side's diff over the base. */
interface EditRun {
  /** Base line range covered (0-based, end exclusive; equal for insertions). */
  baseStart: number
  baseEnd: number
  /** Side-text line range replaced (0-based, end exclusive). */
  textStart: number
  textEnd: number
  /** Replacement lines (empty for pure deletions). */
  lines: string[]
}

/** Derives the edit runs of a diff over the base. */
function editRuns(diff: DiffLine[]): EditRun[] {
  const runs: EditRun[] = []
  let basePos = 0
  let textPos = 0
  let i = 0
  while (i < diff.length) {
    const line = diff[i]
    if (line === undefined) {
      break
    }
    if (line.kind === 'unchanged') {
      basePos++
      textPos++
      i++
      continue
    }
    const baseStart = basePos
    const textStart = textPos
    const added: string[] = []
    while (i < diff.length) {
      const op = diff[i]
      if (op === undefined || op.kind === 'unchanged') {
        break
      }
      if (op.kind === 'removed') {
        basePos++
      } else {
        added.push(op.text)
        textPos++
      }
      i++
    }
    runs.push({ baseStart, baseEnd: basePos, textStart, textEnd: textPos, lines: added })
  }
  return runs
}

function equalArrays(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false
    }
  }
  return true
}

const CONFLICT_START = '<<<<<<< local'
const CONFLICT_SEPARATOR = '======='
const CONFLICT_END = '>>>>>>> upstream'

/**
 * M20.1 `mergeTexts()`: 3-way merge of one file's content. Returns the merged
 * text (conflict markers embedded by default) plus a structured conflict
 * list.
 */
export function mergeTexts(
  base: string,
  local: string,
  upstream: string,
  options: MergeTextOptions = {},
): MergeResult {
  const baseLines = splitTextLines(base)
  const localLines = splitTextLines(local)
  const upstreamLines = splitTextLines(upstream)
  const conflictMarkers = options.conflictMarkers ?? true

  const ourRuns = editRuns(diffLineArrays(baseLines, localLines))
  const theirRuns = editRuns(diffLineArrays(baseLines, upstreamLines))

  const out: MergedLine[] = []
  const conflicts: MergeConflict[] = []
  let basePos = 0
  let ourIdx = 0
  let theirIdx = 0
  let mergedPos = 0
  const INF = Number.POSITIVE_INFINITY

  const emitEqual = (start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      out.push({
        kind: 'merged',
        text: baseLines[i] ?? '',
        baseLine: i + 1,
        localLine: i + 1,
        upstreamLine: i + 1,
      })
      mergedPos++
    }
  }

  const emitRun = (run: EditRun, kind: 'local' | 'upstream'): void => {
    const lineKind = kind === 'local' ? 'localLine' : 'upstreamLine'
    for (let i = 0; i < run.lines.length; i++) {
      const line: MergedLine = { kind, text: run.lines[i] ?? '' }
      if (lineKind === 'localLine') {
        line.localLine = run.textStart + i + 1
      } else {
        line.upstreamLine = run.textStart + i + 1
      }
      out.push(line)
      mergedPos++
    }
  }

  /**
   * Emits one conflict over the union of both runs, folding in any further
   * runs of either side whose base region starts inside the union (crossing
   * changes) so the conflict stays contiguous and no base line is consumed
   * twice. Advances `ourIdx`/`theirIdx` past every folded run.
   */
  const emitConflict = (our: EditRun, their: EditRun): void => {
    let conflictEnd = Math.max(our.baseEnd, their.baseEnd)
    const localStart = our.textStart
    let localEnd = our.textEnd
    const upstreamStart = their.textStart
    let upstreamEnd = their.textEnd
    const localLines = [...our.lines]
    const upstreamLines = [...their.lines]
    ourIdx++
    theirIdx++
    for (;;) {
      const nextOur = ourRuns[ourIdx]
      const nextTheir = theirRuns[theirIdx]
      let advanced = false
      if (nextOur !== undefined && nextOur.baseStart < conflictEnd) {
        localLines.push(...nextOur.lines)
        localEnd = nextOur.textEnd
        conflictEnd = Math.max(conflictEnd, nextOur.baseEnd)
        ourIdx++
        advanced = true
      }
      if (nextTheir !== undefined && nextTheir.baseStart < conflictEnd) {
        upstreamLines.push(...nextTheir.lines)
        upstreamEnd = nextTheir.textEnd
        conflictEnd = Math.max(conflictEnd, nextTheir.baseEnd)
        theirIdx++
        advanced = true
      }
      if (!advanced) {
        break
      }
    }

    const start = mergedPos
    if (conflictMarkers) {
      out.push({ kind: 'conflict-start', text: CONFLICT_START })
      mergedPos++
    }
    for (let i = 0; i < localLines.length; i++) {
      out.push({ kind: 'local', text: localLines[i] ?? '', localLine: localStart + i + 1 })
      mergedPos++
    }
    if (conflictMarkers) {
      out.push({ kind: 'conflict-separator', text: CONFLICT_SEPARATOR })
      mergedPos++
    }
    for (let i = 0; i < upstreamLines.length; i++) {
      out.push({
        kind: 'upstream',
        text: upstreamLines[i] ?? '',
        upstreamLine: upstreamStart + i + 1,
      })
      mergedPos++
    }
    if (conflictMarkers) {
      out.push({ kind: 'conflict-end', text: CONFLICT_END })
      mergedPos++
    }
    conflicts.push({
      localStart: localStart + 1,
      localEnd,
      upstreamStart: upstreamStart + 1,
      upstreamEnd,
      mergedStart: start + 1,
      mergedEnd: mergedPos,
      localLines,
      upstreamLines,
    })
    basePos = conflictEnd
  }

  for (;;) {
    const our = ourRuns[ourIdx]
    const their = theirRuns[theirIdx]
    const ourStart = our?.baseStart ?? INF
    const theirStart = their?.baseStart ?? INF
    if (ourStart === INF && theirStart === INF) {
      break
    }
    if (ourStart < theirStart) {
      if (our !== undefined && their !== undefined && theirStart <= our.baseEnd) {
        // Their change starts inside our change region → conflict over the union.
        emitEqual(basePos, ourStart)
        emitConflict(our, their)
      } else if (our !== undefined) {
        emitEqual(basePos, ourStart)
        emitRun(our, 'local')
        basePos = our.baseEnd
        ourIdx++
      } else {
        break
      }
    } else if (theirStart < ourStart) {
      if (our !== undefined && their !== undefined && ourStart <= their.baseEnd) {
        emitEqual(basePos, theirStart)
        emitConflict(our, their)
      } else if (their !== undefined) {
        emitEqual(basePos, theirStart)
        emitRun(their, 'upstream')
        basePos = their.baseEnd
        theirIdx++
      } else {
        break
      }
    } else if (our !== undefined && their !== undefined) {
      // Same region changed by both sides.
      emitEqual(basePos, ourStart)
      if (our.baseEnd === their.baseEnd && equalArrays(our.lines, their.lines)) {
        // Identical change on both sides — auto-resolved, emitted once.
        emitRun(our, 'local')
        basePos = our.baseEnd
        ourIdx++
        theirIdx++
      } else {
        emitConflict(our, their)
      }
    } else {
      break
    }
  }
  emitEqual(basePos, baseLines.length)

  const mergedText = out
    .map((line) => line.text)
    .join('\n')
    .concat(out.length > 0 ? '\n' : '')

  return { ok: conflicts.length === 0, mergedText, conflicts, lines: out }
}

/**
 * Whether a file still contains unresolved conflict markers (the format
 * `mergeTexts` writes). A `=======` line alone (e.g. a Markdown setext
 * underline) does not count — only `<<<<<<<` / `>>>>>>>` marker lines do.
 */
export function containsConflictMarkers(text: string): boolean {
  const marker = /^(?:<<<<<<<|>>>>>>>)(?: |$)/
  return splitTextLines(text).some((line) => marker.test(line))
}
