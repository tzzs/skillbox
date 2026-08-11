import { describe, expect, it } from 'vitest'
import { assertNever } from './index.js'

describe('shared', () => {
  it('throws for unexpected values', () => {
    expect(() => assertNever('nope' as never)).toThrow('Unexpected value')
  })
})
