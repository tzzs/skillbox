import { describe, expect, it } from 'vitest'
import { absoluteToRelative, modeLabel, statusClass, statusLabel } from './format.js'

describe('statusLabel', () => {
  it('humanizes known statuses', () => {
    expect(statusLabel('ready')).toBe('Ready')
    expect(statusLabel('modified')).toBe('Modified')
    expect(statusLabel('broken')).toBe('Broken')
    expect(statusLabel('missing')).toBe('Missing')
    expect(statusLabel('outdated')).toBe('Outdated')
    expect(statusLabel('conflict')).toBe('Conflict')
  })

  it('falls back to the raw value for unknown statuses', () => {
    expect(statusLabel('weird')).toBe('weird')
  })
})

describe('modeLabel', () => {
  it('maps modes to display names', () => {
    expect(modeLabel('local')).toBe('Local')
    expect(modeLabel('managed')).toBe('Managed')
  })

  it('falls back to the raw value', () => {
    expect(modeLabel('other')).toBe('other')
  })
})

describe('statusClass', () => {
  it('produces a safe CSS class name', () => {
    expect(statusClass('modified')).toBe('status-modified')
    expect(statusClass('Ready!')).toBe('status-ready')
  })
})

describe('absoluteToRelative', () => {
  it('removes the repository root prefix', () => {
    expect(absoluteToRelative('E:/repo/skills/foo', 'E:/repo')).toBe('/skills/foo')
  })

  it('returns the value untouched when it is outside the root', () => {
    expect(absoluteToRelative('/other/path', 'E:/repo')).toBe('/other/path')
  })

  it('shows an em dash for missing values', () => {
    expect(absoluteToRelative(undefined)).toBe('—')
  })
})
