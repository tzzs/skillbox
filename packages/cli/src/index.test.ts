import { describe, expect, it } from 'vitest'
import { main, type CliDeps } from './index.js'

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
})
