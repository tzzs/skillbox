import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import { acquireRuntimeLock, withRuntimeLock, lockDirOf } from './lock.js'

describe('runtime lock', () => {
  it('acquires and releases the lock file', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireRuntimeLock('mutation', { homeRoot: dir })
      expect(handle.owner.pid).toBe(process.pid)
      await expect(fs.stat(lockPath(dir, 'mutation'))).resolves.toBeDefined()
      await handle.release()
      await expect(fs.stat(lockPath(dir, 'mutation'))).rejects.toThrow()
    })
  })

  it('rejects a live lock held by another process', async () => {
    await withTempDir(async (dir) => {
      const now = { value: 1_000 }
      const first = await acquireRuntimeLock('mutation', {
        homeRoot: dir,
        now: () => now.value,
        hostname: () => 'host-a',
        pid: 111,
      })
      now.value = 2_000 // 1s later — still well below the 10min stale threshold

      const error = await acquireRuntimeLock('mutation', {
        homeRoot: dir,
        now: () => now.value,
        hostname: () => 'host-b',
        pid: 222,
      }).catch((caught: unknown) => caught)

      expect(isSkillboxError(error)).toBe(true)
      expect(error).toMatchObject({
        code: ErrorCode.RUNTIME_LOCKED,
        recoverable: true,
        context: { owner: { pid: 111, hostname: 'host-a' } },
      })
      await first.release()
    })
  })

  it('breaks a stale lock and re-acquires', async () => {
    await withTempDir(async (dir) => {
      const now = { value: 1_000 }
      const stale = await acquireRuntimeLock('mutation', {
        homeRoot: dir,
        now: () => now.value,
        pid: 111,
      })
      now.value = 1_000 + 11 * 60 * 1_000 // > 10min stale threshold
      // The stale owner "crashed" without releasing.
      void stale

      const handle = await acquireRuntimeLock('mutation', {
        homeRoot: dir,
        now: () => now.value,
        pid: 222,
      })
      expect(handle.owner.pid).toBe(222)
      await handle.release()
    })
  })

  it('withRuntimeLock releases even when the callback throws', async () => {
    await withTempDir(async (dir) => {
      await expect(
        withRuntimeLock(
          'mutation',
          async () => {
            throw new Error('boom')
          },
          { homeRoot: dir },
        ),
      ).rejects.toThrow('boom')
      await expect(fs.stat(lockPath(dir, 'mutation'))).rejects.toThrow()
    })
  })

  it('release does not remove a lock re-acquired by a newer process', async () => {
    await withTempDir(async (dir) => {
      const now = { value: 1_000 }
      const first = await acquireRuntimeLock('mutation', {
        homeRoot: dir,
        now: () => now.value,
        pid: 111,
      })
      // Another process breaks the stale lock and acquires it.
      now.value = 1_000 + 11 * 60 * 1_000
      const second = await acquireRuntimeLock('mutation', {
        homeRoot: dir,
        now: () => now.value,
        pid: 222,
      })
      // The first owner releases late — its lock is gone; it must not remove
      // the new owner's file.
      await first.release()
      await expect(fs.stat(lockPath(dir, 'mutation'))).resolves.toBeDefined()
      await second.release()
    })
  })
})

function lockPath(homeRoot: string, name: string): string {
  return path.join(lockDirOf(homeRoot), `${name}.lock`)
}
