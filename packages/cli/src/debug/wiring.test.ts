import { describe, expect, it } from 'vitest'
import { main, type CliDeps } from '../index.js'
import { createDefaultDebugBundleProvider } from './loaders.js'
import type { DebugBundleInput, DebugBundleProvider } from './types.js'

class FakeDebugBundleProvider implements DebugBundleProvider {
  calls: DebugBundleInput[] = []

  async create(input: DebugBundleInput) {
    this.calls.push(input)
    return {
      outputFile: '/home/.skillbox/logs/debug-bundle.json',
      generatedAt: '2026-08-13T00:00:00.000Z',
    }
  }
}

function capture(): { deps: CliDeps; out: () => string } {
  let stdout = ''
  return {
    deps: {
      repositoryRoot: '/repo',
      homeRoot: '/home/.skillbox',
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: () => undefined,
    },
    out: () => stdout,
  }
}

describe('skillbox debug-bundle', () => {
  it('creates a redacted Core support artifact for the current repository', async () => {
    const io = capture()
    const debugBundleProvider = new FakeDebugBundleProvider()
    await expect(main(['debug-bundle'], { ...io.deps, debugBundleProvider })).resolves.toBe(0)
    expect(debugBundleProvider.calls).toEqual([
      { repositoryRoot: '/repo', homeRoot: '/home/.skillbox' },
    ])
    expect(io.out()).toContain('Debug bundle created: /home/.skillbox/logs/debug-bundle.json')
  })

  it('adapts Core createDebugBundle', async () => {
    const seen: unknown[] = []
    const provider = createDefaultDebugBundleProvider(async () => ({
      createDebugBundle: async (input: unknown) => {
        seen.push(input)
        return { outputFile: '/bundle', generatedAt: 'now' }
      },
    }))
    await expect(provider.create({ repositoryRoot: '/repo', homeRoot: '/home' })).resolves.toEqual({
      outputFile: '/bundle',
      generatedAt: 'now',
    })
    expect(seen).toEqual([{ repositoryRoot: '/repo', homeRoot: '/home' }])
  })
})
