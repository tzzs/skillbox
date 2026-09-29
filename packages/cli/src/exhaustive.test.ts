import { describe, expect, it } from 'vitest'
import { assertNever } from './exhaustive.js'

describe('assertNever', () => {
  it('throws for unexpected values', () => {
    expect(() => assertNever('nope' as never)).toThrow('Unexpected value')
  })
})
