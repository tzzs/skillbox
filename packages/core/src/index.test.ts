import { describe, expect, it } from 'vitest'
import { version } from './index.js'

describe('core', () => {
  it('exports a semver version string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
