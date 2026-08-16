import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { OperationJournal } from './journal.js'

describe('OperationJournal', () => {
  it('persists lifecycle and recovers unfinished operations', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-journal-'))
    const journal = new OperationJournal({ homeRoot: home, pid: 42, hostname: 'test' })
    const record = await journal.begin('install', 'op-1')
    await journal.update(record.id, { state: 'started', phase: 'download' })
    const restarted = new OperationJournal({ homeRoot: home, pid: 43, hostname: 'test' })
    const recovered = await restarted.recoverUnfinished()
    expect(recovered.map((item) => item.id)).toEqual(['op-1'])
    expect((await journal.list())[0]?.state).toBe('recovered')
    await fs.rm(home, { recursive: true, force: true })
  })

  it('records completed operations', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-journal-'))
    const journal = new OperationJournal({ homeRoot: home })
    const record = await journal.begin('sync')
    await journal.update(record.id, { state: 'completed' })
    expect((await journal.list())[0]?.state).toBe('completed')
    await fs.rm(home, { recursive: true, force: true })
  })
})
