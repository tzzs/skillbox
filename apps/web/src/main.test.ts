import { describe, expect, it } from 'vitest'
import { appName } from './main.js'

describe('web placeholder', () => {
  it('is a placeholder for the future web app', () => {
    expect(appName).toBe('skillbox-web')
  })
})
