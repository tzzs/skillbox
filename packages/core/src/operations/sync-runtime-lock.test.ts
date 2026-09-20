import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withTempDir } from '../fs/test-utils.js'
import {
  acquireOperationLock,
  isStaleOperationLock,
  operationLockPath,
  readOperationLock,
  repositoryKey,
} from './sync-runtime-lock.js'

const owner = { id: 'test-owner', pid: 42, hostname: 'test-host' }

describe('operation lock', () => {
  it('is exclusive per repository and releases only its own owner record', async () => {
    await withTempDir(async (dir) => {
      const options = {
        repositoryRoot: path.join(dir, 'repo'),
        stateRoot: path.join(dir, 'state'),
        owner,
      }
      const lock = await acquireOperationLock(options)
      await expect(
        acquireOperationLock({ ...options, owner: { ...owner, id: 'other' } }),
      ).rejects.toMatchObject({ code: 'LOCK_HELD' })
      await lock.release()
      await expect(
        acquireOperationLock({ ...options, owner: { ...owner, id: 'other' } }),
      ).resolves.toBeDefined()
    })
  })

  it('recovers an expired lock using the injected clock', async () => {
    await withTempDir(async (dir) => {
      let now = 1_000
      const options = {
        repositoryRoot: path.join(dir, 'repo'),
        stateRoot: path.join(dir, 'state'),
        owner,
        staleAfterMs: 10,
        clock: { now: () => now },
      }
      await acquireOperationLock(options)
      now = 1_011
      const recovered = await acquireOperationLock({
        ...options,
        owner: { ...owner, id: 'recovered' },
      })
      expect(recovered.record.owner.id).toBe('recovered')
    })
  })

  it('derives a stable key without exposing the repository path', () => {
    const root = path.resolve('private/repository')
    const key = repositoryKey(root)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(operationLockPath('/state', key)).toContain(key)
    expect(isStaleOperationLock(undefined, 0)).toBe(true)
  })

  it('refuses to release after ownership is replaced', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = path.join(dir, 'state')
      const repositoryRoot = path.join(dir, 'repo')
      const lock = await acquireOperationLock({ repositoryRoot, stateRoot, owner })
      await lock.release()
      await acquireOperationLock({
        repositoryRoot,
        stateRoot,
        owner: { ...owner, id: 'new-owner' },
      })
      await expect(lock.release()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP_LOST' })
      expect(await readOperationLock(lock.path)).toMatchObject({ owner: { id: 'new-owner' } })
    })
  })
})
