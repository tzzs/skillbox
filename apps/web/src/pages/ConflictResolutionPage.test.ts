import { describe, expect, it } from 'vitest'
import type { SyncConflictView } from '../api.js'
import { explain } from './ConflictResolutionPage.js'

function conflict(overrides: Partial<SyncConflictView>): SyncConflictView {
  return {
    id: 'c1',
    type: 'content',
    allowedResolutions: ['local', 'remote'],
    destructive: false,
    ...overrides,
  }
}

describe('explain', () => {
  it('names the deleted-vs-modified tradeoff for delete-modify conflicts', () => {
    expect(explain(conflict({ type: 'delete-modify' }))).toBe(
      'One device removed this skill while the other changed it — choose whether to keep the change.',
    )
  })

  it('mentions the changed field for mode/source/lifecycle conflicts when one is given', () => {
    expect(explain(conflict({ type: 'mode', field: 'mode' }))).toBe(
      'Both devices changed how this skill is managed (mode) — choose one setup.',
    )
    expect(explain(conflict({ type: 'source' }))).toBe(
      'Both devices changed how this skill is managed — choose one setup.',
    )
    expect(explain(conflict({ type: 'lifecycle' }))).toBe(
      'Both devices changed how this skill is managed — choose one setup.',
    )
  })

  it('names the changed manifest field when given', () => {
    expect(explain(conflict({ type: 'manifest-field', field: 'description' }))).toBe(
      'Both devices changed "description".',
    )
  })

  it('falls back to the path for a plain content conflict', () => {
    expect(explain(conflict({ type: 'content', path: 'SKILL.md' }))).toBe(
      'Both devices changed SKILL.md.',
    )
  })

  it('falls back to a generic message when there is no path to name', () => {
    expect(explain(conflict({ type: 'content' }))).toBe(
      'Both devices changed this at the same time.',
    )
  })
})
