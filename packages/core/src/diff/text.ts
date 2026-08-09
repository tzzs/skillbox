/**
 * M19.1 Text Diff Engine — self-contained line diff over arbitrary text
 * (Markdown / JSON / YAML / Code). No external dependencies: a classic Myers
 * O(ND) diff (with full trace) computes the edit script, and the unified-diff
 * renderer groups changes into hunks with configurable context.
 */

export type DiffLineKind = 'unchanged' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffLineKind
  /** 1-based line number in the base text (present for `unchanged`/`removed`). */
  baseLine?: number
  /** 1-based line number in the target text (present for `unchanged`/`added`). */
  targetLine?: number
  text: string
}

/** One contiguous hunk of a unified diff (context expanded, hunks merged). */
export interface DiffHunk {
  /** 1-based first base line of the hunk. */
  baseStart: number
  /** Number of base lines covered by the hunk (0 for pure insertions). */
  baseCount: number
  /** 1-based first target line of the hunk. */
  targetStart: number
  /** Number of target lines covered by the hunk (0 for pure deletions). */
  targetCount: number
  lines: DiffLine[]
}

export interface UnifiedDiffOptions {
  /** Context lines around each change (default 3). */
  context?: number
  /** File name in the `---` header (default `base`). */
  baseName?: string
  /** File name in the `+++` header (default `target`). */
  targetName?: string
}

/**
 * Splits text into diffable lines: LF line endings (CRLF and lone CR collapse
 * to LF), and no phantom trailing line when the text does not end with `\n`.
 */
export function splitTextLines(text: string): string[] {
  if (text.length === 0) {
    return []
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

type EditOp = 'keep' | 'insert' | 'delete'

/**
 * Myers diff of two line arrays. Returns the minimal edit script as a list of
 * ops in document order (`keep` consumes one base and one target line,
 * `delete` one base line, `insert` one target line).
 */
function myersEditScript(baseLines: string[], targetLines: string[]): EditOp[] {
  const n = baseLines.length
  const m = targetLines.length
  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []
  let distance = 0

  // `trace[d]` stores `v` before the distance-`d` iteration, i.e. the state
  // after distance `d - 1` — exactly what the backtrack reads as the previous
  // state of each move. The finish is recorded with `break` so `distance`
  // stays at the finishing D.
  for (; distance <= max; distance++) {
    trace.push(Int32Array.from(v))
    let finished = false
    for (let k = -distance; k <= distance; k += 2) {
      let x: number
      if (
        k === -distance ||
        (k !== distance && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
      ) {
        x = v[offset + k + 1] ?? 0
      } else {
        x = (v[offset + k - 1] ?? 0) + 1
      }
      let y = x - k
      while (x < n && y < m && baseLines[x] === targetLines[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        finished = true
        break
      }
    }
    if (finished) {
      break
    }
  }

  // Backtrack through the trace to recover the edit script (reversed).
  const ops: EditOp[] = []
  let x = n
  let y = m
  for (let step = distance; step > 0; step--) {
    const prev = trace[step]
    if (prev === undefined) {
      break
    }
    const k = x - y
    let prevK: number
    if (k === -step || (k !== step && (prev[offset + k - 1] ?? 0) < (prev[offset + k + 1] ?? 0))) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = prev[offset + prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('keep')
      x--
      y--
    }
    if (x === prevX) {
      ops.push('insert')
      y--
    } else {
      ops.push('delete')
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push('keep')
    x--
    y--
  }
  ops.reverse()
  return ops
}

/** Line diff of two line arrays (shared by `diffTexts` and the merge engine). */
export function diffLineArrays(baseLines: string[], targetLines: string[]): DiffLine[] {
  const ops = myersEditScript(baseLines, targetLines)
  if (ops.every((op) => op === 'keep')) {
    // Identical content — an empty diff, like git's.
    return []
  }
  const result: DiffLine[] = []
  let baseIdx = 0
  let targetIdx = 0
  for (const op of ops) {
    if (op === 'keep') {
      result.push({
        kind: 'unchanged',
        baseLine: baseIdx + 1,
        targetLine: targetIdx + 1,
        text: baseLines[baseIdx] ?? '',
      })
      baseIdx++
      targetIdx++
    } else if (op === 'delete') {
      result.push({ kind: 'removed', baseLine: baseIdx + 1, text: baseLines[baseIdx] ?? '' })
      baseIdx++
    } else {
      result.push({ kind: 'added', targetLine: targetIdx + 1, text: targetLines[targetIdx] ?? '' })
      targetIdx++
    }
  }
  return result
}

/**
 * M19.1 `diffTexts()`: line-level diff between two texts. Every line of both
 * inputs appears exactly once in the output, in document order.
 */
export function diffTexts(base: string, target: string): DiffLine[] {
  return diffLineArrays(splitTextLines(base), splitTextLines(target))
}

function buildHunk(
  diff: DiffLine[],
  firstIndex: number,
  lastIndex: number,
  context: number,
): DiffHunk {
  const first = Math.max(0, firstIndex - context)
  const last = Math.min(diff.length - 1, lastIndex + context)
  const lines = diff.slice(first, last + 1)

  let baseBefore = 0
  let targetBefore = 0
  for (let i = 0; i < first; i++) {
    const line = diff[i]
    if (line !== undefined && line.kind !== 'added') {
      baseBefore++
    }
    if (line !== undefined && line.kind !== 'removed') {
      targetBefore++
    }
  }

  let baseCount = 0
  let targetCount = 0
  let firstBaseLine: number | undefined
  let firstTargetLine: number | undefined
  for (const line of lines) {
    if (line.baseLine !== undefined) {
      baseCount++
      if (firstBaseLine === undefined) {
        firstBaseLine = line.baseLine
      }
    }
    if (line.targetLine !== undefined) {
      targetCount++
      if (firstTargetLine === undefined) {
        firstTargetLine = line.targetLine
      }
    }
  }

  // A hunk without base lines is a pure insertion: its header start is the
  // base position where the insertion lands (0-based count of base lines
  // before the hunk). A hunk without target lines is a pure deletion: its
  // target start is the position where the deletion lands (1-based).
  const baseStart = firstBaseLine ?? baseBefore
  const targetStart = firstTargetLine ?? targetBefore + 1
  return { baseStart, baseCount, targetStart, targetCount, lines }
}

/**
 * Groups a diff into hunks with `context` unchanged lines of context on each
 * side. Hunks whose context windows touch or overlap are merged.
 */
export function groupHunks(diff: DiffLine[], context = 3): DiffHunk[] {
  const changedIndexes: number[] = []
  for (let i = 0; i < diff.length; i++) {
    const line = diff[i]
    if (line !== undefined && line.kind !== 'unchanged') {
      changedIndexes.push(i)
    }
  }
  if (changedIndexes.length === 0) {
    return []
  }

  const hunks: DiffHunk[] = []
  let groupStart = changedIndexes[0] ?? 0
  let groupEnd = changedIndexes[0] ?? 0
  for (const index of changedIndexes.slice(1)) {
    const gap = index - groupEnd - 1
    if (gap <= 2 * context) {
      groupEnd = index
    } else {
      hunks.push(buildHunk(diff, groupStart, groupEnd, context))
      groupStart = index
      groupEnd = index
    }
  }
  hunks.push(buildHunk(diff, groupStart, groupEnd, context))
  return hunks
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`
}

function hunkHeader(hunk: DiffHunk): string {
  const base = formatRange(hunk.baseStart, hunk.baseCount)
  const target = formatRange(hunk.targetStart, hunk.targetCount)
  return `@@ -${base} +${target} @@`
}

/** Unified-diff body (the `@@` hunks only, no `---`/`+++` file headers). */
export function renderUnifiedBody(diff: DiffLine[], options: { context?: number } = {}): string {
  const context = options.context ?? 3
  const hunks = groupHunks(diff, context)
  if (hunks.length === 0) {
    return ''
  }
  const parts: string[] = []
  for (const hunk of hunks) {
    parts.push(hunkHeader(hunk))
    for (const line of hunk.lines) {
      if (line.kind === 'unchanged') {
        parts.push(` ${line.text}`)
      } else if (line.kind === 'removed') {
        parts.push(`-${line.text}`)
      } else {
        parts.push(`+${line.text}`)
      }
    }
  }
  return parts.join('\n')
}

/**
 * M19.1 `renderUnifiedDiff()`: renders a diff as a Unified Diff document with
 * `---`/`+++` file headers and `@@` hunks. An empty (no-change) diff renders
 * as an empty string.
 */
export function renderUnifiedDiff(diff: DiffLine[], options: UnifiedDiffOptions = {}): string {
  const body =
    options.context === undefined
      ? renderUnifiedBody(diff)
      : renderUnifiedBody(diff, { context: options.context })
  if (body === '') {
    return ''
  }
  const baseName = options.baseName ?? 'base'
  const targetName = options.targetName ?? 'target'
  return `--- ${baseName}\n+++ ${targetName}\n${body}`
}
