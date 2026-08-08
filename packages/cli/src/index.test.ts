import { afterEach, describe, expect, it, vi } from 'vitest'
import { main, parseCommand } from './index.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function spyConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('cli', () => {
  it('prints the version for --version', () => {
    spyConsole()
    const exit = main(['--version'])
    expect(exit).toBe(0)
    expect(console.log).toHaveBeenCalledWith('0.1.0')
  })

  it('prints help for --help', () => {
    spyConsole()
    const exit = main(['--help'])
    expect(exit).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
  })

  it('returns a non-zero exit code for unknown arguments', () => {
    spyConsole()
    const exit = main(['bogus'])
    expect(exit).toBe(1)
    expect(console.error).toHaveBeenCalled()
  })

  it('parses version aliases', () => {
    expect(parseCommand(['-v'])).toBe('version')
    expect(parseCommand(['version'])).toBe('version')
  })
})
