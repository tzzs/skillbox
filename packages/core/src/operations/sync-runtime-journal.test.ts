import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withTempDir } from '../fs/test-utils.js'
import { OperationJournal } from './sync-runtime-journal.js'

const owner = { id: 'journal-owner', pid: 7 }

describe('OperationJournal', () => {
  it('writes versioned records atomically and identifies terminal records', async () => {
    await withTempDir(async (dir) => {
      let now = 1_000
      const journal = new OperationJournal({
        repositoryRoot: path.join(dir, 'repo'),
        stateRoot: path.join(dir, 'state'),
        clock: { now: () => now },
      })
      const created = await journal.create({
        operationId: 'op-1',
        kind: 'restore',
        owner,
        stage: 'prepared',
      })
      expect(created).toMatchObject({
        version: 1,
        status: 'running',
        startedAt: new Date(now).toISOString(),
      })
      now = 2_000
      await journal.write({ ...created, status: 'completed', stage: 'committed' })
      const saved = await journal.read('op-1')
      expect(saved).toMatchObject({ status: 'completed', updatedAt: new Date(now).toISOString() })
      expect(journal.isTerminal(saved!)).toBe(true)
      await expect(journal.write({ ...saved!, status: 'running' })).rejects.toMatchObject({
        code: 'JOURNAL_TRANSITION_INVALID',
      })
    })
  })

  it('rejects traversal operation IDs and reports a missing record as undefined', async () => {
    await withTempDir(async (dir) => {
      const journal = new OperationJournal({
        repositoryRoot: path.join(dir, 'repo'),
        stateRoot: path.join(dir, 'state'),
      })
      await expect(journal.read('missing')).resolves.toBeUndefined()
      expect(() => journal.pathFor('../escape')).toThrow('operationId')
    })
  })

  it('lists records for recovery preflight', async () => {
    await withTempDir(async (dir) => {
      const journal = new OperationJournal({
        repositoryRoot: path.join(dir, 'repo'),
        stateRoot: path.join(dir, 'state'),
      })
      await journal.create({ operationId: 'first', kind: 'restore', owner, stage: 'prepared' })
      await journal.create({ operationId: 'second', kind: 'restore', owner, stage: 'prepared' })
      expect((await journal.list()).map((record) => record.operationId).sort()).toEqual([
        'first',
        'second',
      ])
    })
  })
})
