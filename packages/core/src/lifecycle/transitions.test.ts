import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../errors.js'
import { assertLegalTransition, canTransition, LEGAL_LIFECYCLE_TRANSITIONS } from './transitions.js'

describe('lifecycle state machine', () => {
  it('permits every legal transition', () => {
    expect(canTransition('managed', 'forked')).toBe(true)
    expect(canTransition('managed', 'vendored')).toBe(true)
    expect(canTransition('forked', 'vendored')).toBe(true)
    expect(canTransition('forked', 'managed')).toBe(true)
  })

  it('rejects every illegal transition', () => {
    expect(canTransition('vendored', 'forked')).toBe(false)
    expect(canTransition('vendored', 'managed')).toBe(false)
    expect(canTransition('local', 'forked')).toBe(false)
    expect(canTransition('local', 'vendored')).toBe(false)
    expect(canTransition('managed', 'local')).toBe(false)
    expect(canTransition('forked', 'local')).toBe(false)
    expect(canTransition('managed', 'managed')).toBe(false)
    expect(canTransition('forked', 'forked')).toBe(false)
  })

  it('lists only the four legal transitions', () => {
    expect(LEGAL_LIFECYCLE_TRANSITIONS).toEqual([
      ['managed', 'forked'],
      ['managed', 'vendored'],
      ['forked', 'vendored'],
      ['forked', 'managed'],
    ])
  })

  it('throws LIFECYCLE_ILLEGAL_TRANSITION with context for illegal moves', () => {
    let caught: unknown
    try {
      assertLegalTransition('vendored', 'forked', 'frozen')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      code: ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
      context: { alias: 'frozen', from: 'vendored', to: 'forked' },
    })
  })

  it('does not throw for legal moves', () => {
    expect(() => assertLegalTransition('managed', 'forked', 'hello')).not.toThrow()
  })
})
