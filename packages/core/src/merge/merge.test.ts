import { describe, expect, it } from 'vitest'
import { containsConflictMarkers, mergeTexts } from './merge.js'

const MARKED = /<<<<<<< local[\s\S]*=======[\s\S]*>>>>>>> upstream/

describe('mergeTexts', () => {
  it('returns the base unchanged when neither side changed', () => {
    const base = 'a\nb\nc'
    const result = mergeTexts(base, base, base)
    expect(result.ok).toBe(true)
    expect(result.conflicts).toEqual([])
    expect(result.mergedText).toBe('a\nb\nc\n')
  })

  it('applies a change made by one side only (local)', () => {
    const result = mergeTexts('a\nb\nc', 'a\nB\nc', 'a\nb\nc')
    expect(result.ok).toBe(true)
    expect(result.mergedText).toBe('a\nB\nc\n')
  })

  it('applies a change made by one side only (upstream)', () => {
    const result = mergeTexts('a\nb\nc', 'a\nb\nc', 'a\nb\nC')
    expect(result.ok).toBe(true)
    expect(result.mergedText).toBe('a\nb\nC\n')
  })

  it('applies disjoint changes from both sides', () => {
    const result = mergeTexts('a\nb\nc\nd', 'a\nB\nc\nd', 'a\nb\nc\nD')
    expect(result.ok).toBe(true)
    expect(result.mergedText).toBe('a\nB\nc\nD\n')
  })

  it('emits an identical change once when both sides changed the same region the same way', () => {
    const result = mergeTexts('a\nb\nc', 'a\nB\nc', 'a\nB\nc')
    expect(result.ok).toBe(true)
    expect(result.mergedText).toBe('a\nB\nc\n')
    expect(result.mergedText.split('B')).toHaveLength(2)
  })

  it('conflicts when both sides changed the same region differently', () => {
    const result = mergeTexts('a\nb\nc', 'a\nLOCAL\nc', 'a\nUPSTREAM\nc')
    expect(result.ok).toBe(false)
    expect(result.conflicts).toHaveLength(1)
    expect(result.mergedText).toContain('<<<<<<< local\nLOCAL\n=======\nUPSTREAM\n>>>>>>> upstream')
  })

  it('conflicts when one side deleted the region the other side changed', () => {
    const result = mergeTexts('a\nb\nc', 'a\nc', 'a\nB\nc')
    expect(result.ok).toBe(false)
    expect(result.mergedText).toMatch(MARKED)
  })

  it('conflicts when both sides added the same region differently', () => {
    const result = mergeTexts('a\nc', 'a\nL\nc', 'a\nU\nc')
    expect(result.ok).toBe(false)
    expect(result.mergedText).toMatch(MARKED)
  })

  it('folds crossing changes into one contiguous conflict', () => {
    // Local changes lines 1 and 3; upstream changes lines 1-5 → one conflict
    // covering the union of both regions.
    const base = 'l1\nl2\nl3\nl4\nl5\nl6\nl7'
    const local = 'L1\nl2\nL3\nl4\nl5\nl6\nl7'
    const upstream = 'U1\nU2\nU3\nU4\nU5\nl6\nl7'
    const result = mergeTexts(base, local, upstream)
    expect(result.ok).toBe(false)
    expect(result.conflicts).toHaveLength(1)
    expect(result.mergedText).toMatch(MARKED)
    // Both sides' lines are inside the conflict; untouched base lines (l6, l7)
    // survive outside it, each appearing exactly once.
    const lines = result.mergedText.split('\n')
    for (const line of ['L1', 'L3', 'U1', 'U2', 'U3', 'U4', 'U5', 'l6', 'l7']) {
      expect(lines).toContain(line)
    }
    for (const line of ['l2', 'l4', 'l5']) {
      expect(lines).not.toContain(line)
    }
  })

  it('reports 1-based conflict line ranges', () => {
    const result = mergeTexts('a\nb\nc', 'a\nLOCAL\nc', 'a\nUPSTREAM\nc')
    const conflict = result.conflicts[0]
    expect(conflict).toBeDefined()
    expect(conflict?.localStart).toBe(2)
    expect(conflict?.localEnd).toBe(2)
    expect(conflict?.upstreamStart).toBe(2)
    expect(conflict?.upstreamEnd).toBe(2)
    expect(conflict?.localLines).toEqual(['LOCAL'])
    expect(conflict?.upstreamLines).toEqual(['UPSTREAM'])
    // mergedStart..mergedEnd covers both sides + the three marker lines.
    expect(conflict?.mergedEnd).toBe((conflict?.mergedStart ?? 0) + 4)
  })

  it('keeps the final newline on the merged text', () => {
    expect(mergeTexts('a', 'a', 'a').mergedText).toBe('a\n')
  })

  it('merges empty base with both sides empty', () => {
    const result = mergeTexts('', '', '')
    expect(result.ok).toBe(true)
    expect(result.mergedText).toBe('')
  })

  it('emits merged lines with side line numbers', () => {
    const result = mergeTexts('a\nb\nc', 'a\nB\nc', 'a\nb\nc')
    const changed = result.lines.find((line) => line.kind === 'local')
    expect(changed?.localLine).toBe(2)
    expect(changed?.text).toBe('B')
  })
})

describe('containsConflictMarkers', () => {
  it('detects unresolved markers', () => {
    const text = 'ok\n<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> upstream\nok'
    expect(containsConflictMarkers(text)).toBe(true)
  })

  it('accepts resolved content', () => {
    expect(containsConflictMarkers('a\nb')).toBe(false)
  })

  it('ignores a bare setext underline', () => {
    // A Markdown setext underline must not count as a separator.
    expect(containsConflictMarkers('Title\n=======\n')).toBe(false)
  })

  it('requires the marker to be its own line', () => {
    expect(containsConflictMarkers('text <<<<<<< local inline')).toBe(false)
  })
})
