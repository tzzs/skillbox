import { describe, expect, it } from 'vitest'
import { main, type CliDeps } from '../index.js'
import { createDefaultDiagnosticsProvider } from './loaders.js'
import type { DiagnosticsInput, DiagnosticsProvider } from './types.js'

class FakeDiagnosticsProvider implements DiagnosticsProvider {
  calls: DiagnosticsInput[] = []

  async collect(input: DiagnosticsInput) {
    this.calls.push(input)
    return {
      repositoryRoot: input.repositoryRoot,
      ready: true,
      checks: [
        { id: 'node' as const, status: 'pass' as const, version: '22.14.0', minimumMajor: 20 },
        { id: 'git' as const, status: 'pass' as const, installed: true, version: '2.47.1' },
        {
          id: 'manifest' as const,
          status: 'warn' as const,
          present: false,
          path: '/repo/skillbox.yaml',
        },
        {
          id: 'lockfile' as const,
          status: 'warn' as const,
          present: false,
          path: '/repo/skillbox.lock',
        },
      ],
    }
  }
}

function capture(): { deps: CliDeps; out: () => string; err: () => string } {
  let stdout = ''
  let stderr = ''
  return {
    deps: {
      repositoryRoot: '/repo',
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      },
    },
    out: () => stdout,
    err: () => stderr,
  }
}

describe('skillbox doctor', () => {
  it('collects diagnostics for the current repository and renders actionable checks', async () => {
    const io = capture()
    const diagnosticsProvider = new FakeDiagnosticsProvider()

    const exit = await main(['doctor'], { ...io.deps, diagnosticsProvider })

    expect(exit).toBe(0)
    expect(diagnosticsProvider.calls).toEqual([{ repositoryRoot: '/repo' }])
    expect(io.out()).toContain('Skillbox doctor: ready')
    expect(io.out()).toContain('PASS  node')
    expect(io.out()).toContain('WARN  manifest')
    expect(io.out()).toContain('/repo/skillbox.yaml')
    expect(io.err()).toBe('')
  })

  it('writes the unmodified Core report with --json', async () => {
    const io = capture()
    const diagnosticsProvider = new FakeDiagnosticsProvider()

    const exit = await main(['doctor', '--json'], { ...io.deps, diagnosticsProvider })

    expect(exit).toBe(0)
    expect(JSON.parse(io.out())).toEqual({
      repositoryRoot: '/repo',
      ready: true,
      checks: expect.arrayContaining([expect.objectContaining({ id: 'git', version: '2.47.1' })]),
    })
  })

  it('adapts the production provider to Core diagnostic collection', async () => {
    const provider = createDefaultDiagnosticsProvider(async () => ({
      collectDiagnostics: async ({ repositoryRoot }: DiagnosticsInput) => ({
        repositoryRoot,
        ready: false,
        checks: [],
      }),
    }))

    await expect(provider.collect({ repositoryRoot: '/repo' })).resolves.toEqual({
      repositoryRoot: '/repo',
      ready: false,
      checks: [],
    })
  })
})
