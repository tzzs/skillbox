import { describe, expect, it } from 'vitest'
import { main } from '../index.js'
import type { CliDeps } from '../program.js'
import { createDefaultRollbackProvider } from './loaders.js'
import type { RollbackOperationInput, RollbackOperationResult, RollbackProvider } from './types.js'

class FakeRollbackProvider implements RollbackProvider {
  calls: RollbackOperationInput[] = []
  result: RollbackOperationResult = { operationId: 'latest-operation', restoredTargets: 2 }

  async rollbackOperation(input: RollbackOperationInput): Promise<RollbackOperationResult> {
    this.calls.push(input)
    return this.result
  }
}

function capture(): { deps: CliDeps; out: () => string; err: () => string } {
  let stdout = ''
  let stderr = ''
  return {
    deps: {
      repositoryRoot: '/repo',
      homeRoot: '/home/.skillbox',
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

describe('skillbox rollback', () => {
  it('passes repository roots and an explicit operation id to Core', async () => {
    const io = capture()
    const rollbackProvider = new FakeRollbackProvider()

    const exit = await main(['rollback', 'op-123'], { ...io.deps, rollbackProvider })

    expect(exit).toBe(0)
    expect(rollbackProvider.calls).toEqual([
      { repositoryRoot: '/repo', homeRoot: '/home/.skillbox', operationId: 'op-123' },
    ])
    expect(io.out()).toContain('Rolled back operation "latest-operation" — restored 2 targets.')
    expect(io.err()).toBe('')
  })

  it("omits operationId to request Core's latest eligible backup", async () => {
    const io = capture()
    const rollbackProvider = new FakeRollbackProvider()
    rollbackProvider.result = { operationId: 'op-latest' }

    const exit = await main(['rollback'], { ...io.deps, rollbackProvider })

    expect(exit).toBe(0)
    expect(rollbackProvider.calls).toEqual([
      { repositoryRoot: '/repo', homeRoot: '/home/.skillbox' },
    ])
    expect(io.out()).toContain('Rolled back operation "op-latest".')
  })

  it('adapts Core restored target paths to the rendered count', async () => {
    const provider = createDefaultRollbackProvider(async () => ({
      rollbackOperation: async () => ({
        operationId: 'op-core',
        restoredTargets: ['/repo/skillbox.yaml'],
      }),
    }))

    await expect(
      provider.rollbackOperation({
        repositoryRoot: '/repo',
        homeRoot: '/home/.skillbox',
        operationId: 'op-core',
      }),
    ).resolves.toEqual({ operationId: 'op-core', restoredTargets: 1 })
  })
})
