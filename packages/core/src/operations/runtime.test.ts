import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withTempDir } from '../fs/test-utils.js'
import { createOperationRuntime } from './runtime.js'

describe('OperationRuntime.runExclusive', () => {
  it('restores every declared target when a mutation fails', async () => {
    await withTempDir(async (root) => {
      const repositoryRoot = path.join(root, 'repository')
      const homeRoot = path.join(root, 'home')
      const manifest = path.join(repositoryRoot, 'skillbox.yaml')
      await fs.mkdir(repositoryRoot, { recursive: true })
      await fs.writeFile(manifest, 'before\n', 'utf8')
      const runtime = createOperationRuntime({ repositoryRoot, homeRoot })

      await expect(
        runtime.runExclusive({
          kind: 'restore',
          targets: [manifest],
          execute: async () => {
            await fs.writeFile(manifest, 'after\n', 'utf8')
            throw new Error('write failed')
          },
        }),
      ).rejects.toThrow('write failed')

      await expect(fs.readFile(manifest, 'utf8')).resolves.toBe('before\n')
    })
  })

  it('rolls a completed operation back only through its recorded snapshot', async () => {
    await withTempDir(async (root) => {
      const repositoryRoot = path.join(root, 'repository')
      const homeRoot = path.join(root, 'home')
      const manifest = path.join(repositoryRoot, 'skillbox.yaml')
      await fs.mkdir(repositoryRoot, { recursive: true })
      await fs.writeFile(manifest, 'before\n', 'utf8')
      const runtime = createOperationRuntime({ repositoryRoot, homeRoot })
      const completed = await runtime.runExclusive({
        kind: 'restore',
        targets: [manifest],
        execute: async () => fs.writeFile(manifest, 'after\n', 'utf8'),
      })

      await expect(runtime.rollback(completed.operationId)).resolves.toMatchObject({
        operationId: completed.operationId,
        restoredTargets: [manifest],
      })
      await expect(fs.readFile(manifest, 'utf8')).resolves.toBe('before\n')
    })
  })
})
