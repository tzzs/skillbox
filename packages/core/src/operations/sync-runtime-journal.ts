import * as path from 'node:path'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import {
  systemOperationClock,
  type OperationClock,
  type OperationJournalRecord,
  type OperationJournalStatus,
  type OperationKind,
  type OperationOwner,
  isTerminalOperationJournalStatus,
} from './types.js'
import { repositoryKey } from './sync-runtime-lock.js'

export interface OperationJournalOptions {
  repositoryRoot: string
  stateRoot?: string
  filesystem?: FilesystemService
  clock?: OperationClock
  /** Fault-injection seam; production uses same-directory atomic replacement. */
  atomicWrite?: (target: string, data: string) => Promise<void>
}

export interface CreateOperationJournalRecord {
  operationId: string
  kind: OperationKind
  owner: OperationOwner
  stage: string
  metadata?: Record<string, unknown>
}

export class OperationJournalError extends Error {
  constructor(
    message: string,
    readonly code: 'JOURNAL_CORRUPT' | 'JOURNAL_TRANSITION_INVALID',
  ) {
    super(message)
    this.name = 'OperationJournalError'
  }
}

/** JSON journal storage for one repository. Every record replacement is atomic. */
export class OperationJournal {
  private readonly repositoryKey: string
  private readonly root: string
  private readonly filesystem: FilesystemService
  private readonly clock: OperationClock
  private readonly atomicWrite: (target: string, data: string) => Promise<void>

  constructor(options: OperationJournalOptions) {
    this.repositoryKey = repositoryKey(options.repositoryRoot)
    const stateRoot =
      options.stateRoot ??
      path.join(path.resolve(options.repositoryRoot), '.skillbox', 'state', 'operations')
    this.root = path.join(stateRoot, 'journals', this.repositoryKey)
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.clock = options.clock ?? systemOperationClock
    this.atomicWrite = options.atomicWrite ?? atomicWriteFile
  }

  pathFor(operationId: string): string {
    assertOperationId(operationId)
    return path.join(this.root, `${operationId}.json`)
  }

  async create(input: CreateOperationJournalRecord): Promise<OperationJournalRecord> {
    const now = new Date(this.clock.now()).toISOString()
    const record: OperationJournalRecord = {
      version: 1,
      operationId: input.operationId,
      repositoryKey: this.repositoryKey,
      kind: input.kind,
      owner: input.owner,
      status: 'running',
      stage: input.stage,
      startedAt: now,
      updatedAt: now,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    }
    await this.write(record)
    return record
  }

  async read(operationId: string): Promise<OperationJournalRecord | undefined> {
    const target = this.pathFor(operationId)
    if (!(await this.filesystem.exists(target))) return undefined
    const raw = await this.filesystem.readFile(target)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new OperationJournalError(`Invalid operation journal at "${target}"`, 'JOURNAL_CORRUPT')
    }
    if (!isOperationJournalRecord(parsed) || parsed.repositoryKey !== this.repositoryKey) {
      throw new OperationJournalError(`Invalid operation journal at "${target}"`, 'JOURNAL_CORRUPT')
    }
    return parsed
  }

  async list(): Promise<OperationJournalRecord[]> {
    if (!(await this.filesystem.exists(this.root))) return []
    const records: OperationJournalRecord[] = []
    for (const entry of await this.filesystem.readDir(this.root)) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue
      const record = await this.read(entry.name.slice(0, -'.json'.length))
      if (record !== undefined) records.push(record)
    }
    return records
  }

  async write(record: OperationJournalRecord): Promise<void> {
    if (!isOperationJournalRecord(record) || record.repositoryKey !== this.repositoryKey) {
      throw new OperationJournalError(
        'Journal record is invalid for this repository',
        'JOURNAL_CORRUPT',
      )
    }
    const existing = await this.read(record.operationId)
    if (
      existing !== undefined &&
      isTerminalOperationJournalStatus(existing.status) &&
      !isTerminalOperationJournalStatus(record.status)
    ) {
      throw new OperationJournalError(
        'A terminal operation journal cannot become running',
        'JOURNAL_TRANSITION_INVALID',
      )
    }
    const updated: OperationJournalRecord = {
      ...record,
      updatedAt: new Date(this.clock.now()).toISOString(),
    }
    await this.atomicWrite(this.pathFor(record.operationId), `${JSON.stringify(updated)}\n`)
  }

  isTerminal(record: OperationJournalRecord): boolean {
    return isTerminalOperationJournalStatus(record.status)
  }
}

export function isOperationJournalRecord(value: unknown): value is OperationJournalRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const owner = record['owner']
  const validStatuses: OperationJournalStatus[] = [
    'running',
    'completed',
    'failed',
    'rolled-back',
    'abandoned',
  ]
  return (
    record['version'] === 1 &&
    typeof record['operationId'] === 'string' &&
    typeof record['repositoryKey'] === 'string' &&
    typeof record['kind'] === 'string' &&
    validStatuses.includes(record['status'] as OperationJournalStatus) &&
    typeof record['stage'] === 'string' &&
    typeof record['startedAt'] === 'string' &&
    typeof record['updatedAt'] === 'string' &&
    typeof owner === 'object' &&
    owner !== null &&
    typeof (owner as Record<string, unknown>)['id'] === 'string' &&
    typeof (owner as Record<string, unknown>)['pid'] === 'number'
  )
}

function assertOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operationId)) {
    throw new TypeError(
      'operationId must contain only letters, digits, dot, underscore, and hyphen',
    )
  }
}
