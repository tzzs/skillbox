import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { resolveSkillboxHome } from '../runtime/paths.js'

export type OperationState = 'started' | 'completed' | 'failed' | 'recovered'

export interface OperationJournalRecord {
  id: string
  operation: string
  state: OperationState
  startedAt: string
  updatedAt: string
  pid: number
  hostname: string
  phase?: string
  error?: string
}

export interface OperationJournalOptions {
  homeRoot?: string
  now?: () => Date
  pid?: number
  hostname?: string
}

export class OperationJournal {
  private readonly file: string
  private readonly now: () => Date
  private readonly pid: number
  private readonly hostname: string

  constructor(options: OperationJournalOptions = {}) {
    const home = path.resolve(options.homeRoot ?? resolveSkillboxHome())
    this.file = path.join(home, 'state', 'operations', 'journal.json')
    this.now = options.now ?? (() => new Date())
    this.pid = options.pid ?? process.pid
    this.hostname = options.hostname ?? requireHostname()
  }

  async list(): Promise<OperationJournalRecord[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown
      return Array.isArray(parsed) ? (parsed as OperationJournalRecord[]) : []
    } catch {
      return []
    }
  }

  async begin(
    operation: string,
    id = `${Date.now()}-${this.pid}`,
  ): Promise<OperationJournalRecord> {
    const timestamp = this.now().toISOString()
    const record: OperationJournalRecord = {
      id,
      operation,
      state: 'started',
      startedAt: timestamp,
      updatedAt: timestamp,
      pid: this.pid,
      hostname: this.hostname,
    }
    const records = await this.list()
    records.push(record)
    await this.write(records)
    return record
  }

  async update(
    id: string,
    patch: Pick<OperationJournalRecord, 'state'> &
      Partial<Pick<OperationJournalRecord, 'phase' | 'error'>>,
  ): Promise<void> {
    const records = await this.list()
    const record = records.find((item) => item.id === id)
    if (!record) return
    Object.assign(record, patch, { updatedAt: this.now().toISOString() })
    await this.write(records)
  }

  async recoverUnfinished(): Promise<OperationJournalRecord[]> {
    const records = await this.list()
    // Never recover an operation owned by this process; it may still be active.
    const unfinished = records.filter(
      (record) => record.state === 'started' && record.pid !== this.pid,
    )
    if (unfinished.length > 0) {
      const timestamp = this.now().toISOString()
      for (const record of unfinished) {
        record.state = 'recovered'
        record.updatedAt = timestamp
        record.error = 'Operation was unfinished after process exit'
      }
      await this.write(records)
    }
    return unfinished
  }

  private async write(records: OperationJournalRecord[]): Promise<void> {
    await atomicWriteFile(this.file, `${JSON.stringify(records, null, 2)}\n`)
  }
}

function requireHostname(): string {
  return process.env.HOSTNAME ?? 'unknown'
}
