import { describe, expect, it } from 'vitest'
import {
  diffTexts,
  groupHunks,
  renderUnifiedBody,
  renderUnifiedDiff,
  splitTextLines,
  type DiffLine,
} from './text.js'

function texts(diff: DiffLine[]): string[] {
  return diff.map((line) => line.text)
}

describe('splitTextLines', () => {
  it('splits plain text into lines without a phantom trailing line', () => {
    expect(splitTextLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
    expect(splitTextLines('a\nb\nc\n')).toEqual(['a', 'b', 'c'])
  })

  it('returns [] for empty text', () => {
    expect(splitTextLines('')).toEqual([])
    expect(splitTextLines('\n')).toEqual([''])
  })

  it('normalizes CRLF and lone CR to LF', () => {
    expect(splitTextLines('a\r\nb\rc\n')).toEqual(['a', 'b', 'c'])
  })
})

describe('diffTexts', () => {
  it('returns no lines for identical text', () => {
    expect(diffTexts('a\nb\nc', 'a\nb\nc')).toEqual([])
  })

  it('detects a pure insertion with target line numbers', () => {
    const diff = diffTexts('a\nb', 'a\nx\nb')
    expect(texts(diff)).toEqual(['a', 'x', 'b'])
    const added = diff.find((line) => line.kind === 'added')
    expect(added?.targetLine).toBe(2)
  })

  it('detects a pure deletion with base line numbers', () => {
    const diff = diffTexts('a\nx\nb', 'a\nb')
    expect(texts(diff)).toEqual(['a', 'x', 'b'])
    const removed = diff.find((line) => line.kind === 'removed')
    expect(removed?.baseLine).toBe(2)
  })

  it('detects a replacement', () => {
    const diff = diffTexts('a\nold\nb', 'a\nnew\nb')
    const kinds = diff.map((line) => line.kind)
    expect(kinds).toEqual(['unchanged', 'removed', 'added', 'unchanged'])
  })

  it('handles an empty base', () => {
    const diff = diffTexts('', 'a\nb')
    expect(diff.map((line) => line.kind)).toEqual(['added', 'added'])
    expect(diff.map((line) => line.targetLine)).toEqual([1, 2])
  })

  it('handles an empty target', () => {
    const diff = diffTexts('a\nb', '')
    expect(diff.map((line) => line.kind)).toEqual(['removed', 'removed'])
    expect(diff.map((line) => line.baseLine)).toEqual([1, 2])
  })

  it('treats CRLF differences as unchanged', () => {
    expect(diffTexts('a\r\nb\r\n', 'a\nb\n')).toEqual([])
  })

  it('assigns 1-based line numbers in document order', () => {
    const diff = diffTexts('a\nb\nc\nd', 'a\nB\nc\nD')
    const numbered = diff
      .filter((line) => line.kind !== 'unchanged')
      .map((line) => [line.kind, line.baseLine, line.targetLine])
    expect(numbered).toEqual([
      ['removed', 2, undefined],
      ['added', undefined, 2],
      ['removed', 4, undefined],
      ['added', undefined, 4],
    ])
  })
})

describe('groupHunks + renderUnifiedBody', () => {
  it('renders a simple hunk header with counts', () => {
    const diff = diffTexts('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne')
    const body = renderUnifiedBody(diff)
    expect(body).toContain('@@ -1,5 +1,5 @@')
    expect(body).toContain('-c')
    expect(body).toContain('+X')
  })

  it('merges changes whose context windows touch', () => {
    const diff = diffTexts('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng')
    const hunks = groupHunks(diff, 3)
    expect(hunks.length).toBe(1)
  })

  it('keeps distant changes in separate hunks', () => {
    const diff = diffTexts('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk', 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK')
    const hunks = groupHunks(diff, 3)
    expect(hunks.length).toBe(2)
  })

  it('omits the trailing newline lines from the output', () => {
    const diff = diffTexts('a\nb', 'a\nx')
    const body = renderUnifiedBody(diff)
    expect(body.endsWith('\n')).toBe(false)
    expect(body).toMatch(/^@@ -1,2 \+1,2 @@\n a\n-b\n\+x$/)
  })

  it('renders an empty body for no changes', () => {
    expect(renderUnifiedBody(diffTexts('a', 'a'))).toBe('')
  })

  it('respects custom context counts', () => {
    const diff = diffTexts('a\nb\nc\nd\ne', 'a\nX\nc\nd\ne')
    const body = renderUnifiedBody(diff, { context: 0 })
    expect(body).not.toContain('\n b\n c') // context lines absent
    expect(body).toBe('@@ -2 +2 @@\n-b\n+X')
  })
})

describe('renderUnifiedDiff', () => {
  it('renders file headers plus hunks', () => {
    const diff = diffTexts('a\nb', 'a\nx')
    const output = renderUnifiedDiff(diff, { baseName: 'old.md', targetName: 'new.md' })
    expect(output.startsWith('--- old.md\n+++ new.md\n')).toBe(true)
    expect(output).toContain('@@ -1,2 +1,2 @@')
  })

  it('renders empty for identical files', () => {
    expect(renderUnifiedDiff(diffTexts('a', 'a'))).toBe('')
  })

  it('defaults the file names', () => {
    const output = renderUnifiedDiff(diffTexts('a\nb', 'a\nx'))
    expect(output.startsWith('--- base\n+++ target\n')).toBe(true)
  })
})
