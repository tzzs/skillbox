import { describe, expect, it } from 'vitest'
import { main, splitVerbosityFlags, type CliDeps, ExitCode } from './index.js'

/**
 * Captures the CLI's stdout/stderr streams instead of the real process
 * streams, so tests can assert on full output without touching the console.
 */
function capture(): CliDeps & { out(): string; err(): string } {
  const chunks: string[] = []
  const errorChunks: string[] = []
  return {
    stdout: (chunk: string) => chunks.push(chunk),
    stderr: (chunk: string) => errorChunks.push(chunk),
    out: () => chunks.join(''),
    err: () => errorChunks.join(''),
  }
}

describe('cli', () => {
  it('prints the version for --version', async () => {
    const io = capture()
    const exit = await main(['--version'], io)
    expect(exit).toBe(0)
    expect(io.out()).toContain('0.1.0')
  })

  it('prints the version for -v', async () => {
    const io = capture()
    const exit = await main(['-v'], io)
    expect(exit).toBe(0)
    expect(io.out()).toContain('0.1.0')
  })

  it('prints help for --help', async () => {
    const io = capture()
    const exit = await main(['--help'], io)
    expect(exit).toBe(0)
    expect(io.out()).toContain('Usage:')
  })

  it('returns a non-zero exit code for unknown arguments', async () => {
    const io = capture()
    const exit = await main(['bogus'], io)
    expect(exit).toBe(1)
    expect(io.err()).toContain('error:')
  })

  it('lists skills in a repository with no manifest', async () => {
    const io = capture()
    const exit = await main(['list', '--json'], io)
    expect(exit).toBe(0)
    expect(io.out()).toContain('"skills"')
  })

  it('refuses the interactive mode without a TTY instead of crashing', async () => {
    const io = capture()
    const exit = await main([], { ...io, isInteractive: false })
    expect(exit).toBe(ExitCode.GENERIC)
    expect(io.err()).toContain('interactive mode')
    expect(io.out()).toBe('')
  })
})

describe('splitVerbosityFlags', () => {
  it('returns the input arguments unchanged without verbosity flags', () => {
    expect(splitVerbosityFlags(['list', '--json'])).toEqual({
      args: ['list', '--json'],
      verbosity: 'normal',
    })
  })

  it('recognises --debug as the highest verbosity', () => {
    expect(splitVerbosityFlags(['--debug', 'status'])).toEqual({
      args: ['status'],
      verbosity: 'debug',
    })
  })

  it('recognises --verbose and accepts the =true spelling', () => {
    expect(splitVerbosityFlags(['--verbose=true', 'list'])).toEqual({
      args: ['list'],
      verbosity: 'verbose',
    })
  })

  it('lets --debug win over --verbose regardless of ordering', () => {
    expect(splitVerbosityFlags(['--debug', '--verbose', 'status'])).toEqual({
      args: ['status'],
      verbosity: 'debug',
    })
    expect(splitVerbosityFlags(['--verbose', '--debug', 'status'])).toEqual({
      args: ['status'],
      verbosity: 'debug',
    })
  })

  it('keeps tokens after a literal -- verbatim', () => {
    expect(splitVerbosityFlags(['--debug', '--', '--verbose'])).toEqual({
      args: ['--', '--verbose'],
      verbosity: 'debug',
    })
  })
})
