import { describe, expect, it } from 'vitest'
import { BackupIndexStore } from './backup-index.js'
import { withTempDir } from '../fs/test-utils.js'
import path from 'node:path'

describe('backup index', () => {
  it('only returns completed, non-expired records for the same repository', async () => {
    await withTempDir(async (root) => {
      const store = new BackupIndexStore(path.join(root, 'backups.json'))
      await store.add({
        repositoryKey: 'repo-a',
        operationId: 'complete',
        snapshotId: 'snap-complete',
        state: 'completed',
        createdAt: '2026-08-13T00:00:00.000Z',
        completedAt: '2026-08-13T00:01:00.000Z',
        expiresAt: '2026-08-14T00:00:00.000Z',
        snapshotPaths: [],
        targets: [],
      })
      await store.add({
        repositoryKey: 'repo-a',
        operationId: 'active',
        snapshotId: 'snap-active',
        state: 'active',
        createdAt: '2026-08-13T00:00:00.000Z',
        expiresAt: '2026-08-14T00:00:00.000Z',
        snapshotPaths: [],
        targets: [],
      })
      await expect(
        store.requireCompleted('complete', 'repo-b', new Date('2026-08-13T02:00:00.000Z')),
      ).rejects.toThrow(/repository/i)
      await expect(
        store.requireCompleted('active', 'repo-a', new Date('2026-08-13T02:00:00.000Z')),
      ).rejects.toThrow(/completed/i)
      await expect(
        store.requireCompleted('complete', 'repo-a', new Date('2026-08-15T00:00:00.000Z')),
      ).rejects.toThrow(/expired/i)
      expect(
        (await store.requireCompleted('complete', 'repo-a', new Date('2026-08-13T02:00:00.000Z')))
          .operationId,
      ).toBe('complete')
    })
  })

  it('retains active records while removing expired and oldest completed records', async () => {
    await withTempDir(async (root) => {
      const store = new BackupIndexStore(path.join(root, 'backups.json'))
      const record = (
        id: string,
        state: 'active' | 'completed',
        completedAt?: string,
        expiresAt = '2026-08-20T00:00:00.000Z',
      ) => ({
        repositoryKey: 'repo-a',
        operationId: id,
        snapshotId: `snap-${id}`,
        state,
        createdAt: '2026-08-13T00:00:00.000Z',
        expiresAt,
        snapshotPaths: [],
        targets: [],
        ...(completedAt === undefined ? {} : { completedAt }),
      })
      await store.add(record('old', 'completed', '2026-08-13T01:00:00.000Z'))
      await store.add(record('new', 'completed', '2026-08-13T02:00:00.000Z'))
      await store.add(record('active', 'active'))
      await store.add(
        record('expired', 'completed', '2026-08-12T01:00:00.000Z', '2026-08-13T00:00:00.000Z'),
      )

      const removed = await store.prune({
        now: new Date('2026-08-13T03:00:00.000Z'),
        maxCompleted: 1,
      })
      expect(removed.map((entry) => entry.operationId).sort()).toEqual(['expired', 'old'])
      expect((await store.list()).map((entry) => entry.operationId).sort()).toEqual([
        'active',
        'new',
      ])
    })
  })
})
