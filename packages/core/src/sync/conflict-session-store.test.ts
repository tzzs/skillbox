import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../errors.js'
import { repositoryKey } from '../operations/lock.js'
import { ConflictSessionStore } from './conflict-session-store.js'
import type { ConflictSession } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function session(repositoryRoot: string, expiresAt = '2030-01-01T00:00:00.000Z'): ConflictSession {
  return {
    version: 1,
    id: 'session-one',
    repositoryId: repositoryKey(repositoryRoot),
    baseRevision: 'a'.repeat(40),
    localRevision: 'b'.repeat(40),
    remoteRevision: 'c'.repeat(40),
    snapshotId: 'snapshot-one',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt,
    conflicts: [],
  }
}

describe('ConflictSessionStore', () => {
  it('writes sessions atomically and returns the validated session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-sessions-'))
    roots.push(root)
    const repositoryRoot = path.join(root, 'repository')
    const store = new ConflictSessionStore({ repositoryRoot, homeRoot: path.join(root, 'home') })
    const saved = session(repositoryRoot)
    await store.save(saved)
    await expect(store.get(saved.id)).resolves.toEqual(saved)
    await expect(store.list()).resolves.toEqual([saved])
  })

  it('rejects expired and malformed sessions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-sessions-'))
    roots.push(root)
    const repositoryRoot = path.join(root, 'repository')
    const homeRoot = path.join(root, 'home')
    const store = new ConflictSessionStore({
      repositoryRoot,
      homeRoot,
      now: () => Date.parse('2026-02-01'),
    })
    await store.save(session(repositoryRoot, '2026-01-01T00:00:00.000Z'))
    await expect(store.get('session-one')).rejects.toMatchObject({
      code: ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED,
    })
    await expect(store.cleanExpired()).resolves.toEqual(['session-one'])
  })
})
