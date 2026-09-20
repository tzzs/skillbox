import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { systemOperationClock, type OperationClock, type OperationOwner } from './types.js'

export interface OperationLockRecord {
  version: 1
  repositoryKey: string
  owner: OperationOwner
  acquiredAt: string
  expiresAt: string
}

export interface AcquireOperationLockOptions {
  repositoryRoot: string
  /** Shared Skillbox state directory. Defaults to a repository-local state directory. */
  stateRoot?: string
  owner: OperationOwner
  staleAfterMs?: number
  filesystem?: FilesystemService
  clock?: OperationClock
}

export interface OperationLock {
  readonly record: OperationLockRecord
  readonly path: string
  release(): Promise<void>
}

export class OperationLockError extends Error {
  constructor(
    message: string,
    readonly code: 'LOCK_HELD' | 'LOCK_OWNERSHIP_LOST' | 'LOCK_CORRUPT',
    readonly record?: OperationLockRecord,
  ) {
    super(message)
    this.name = 'OperationLockError'
  }
}

/** Stable privacy-preserving key for a normalized repository path. */
export function repositoryKey(repositoryRoot: string): string {
  const absolute = path.resolve(repositoryRoot)
  const normalized = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  return createHash('sha256').update(normalized).digest('hex')
}

export function operationLockPath(stateRoot: string, key: string): string {
  return path.join(stateRoot, `${key}.lock`)
}

/**
 * Acquires an exclusive, repository-keyed lock by atomically creating its
 * directory. An expired owner record is removed and acquisition retried once.
 */
export async function acquireOperationLock(
  options: AcquireOperationLockOptions,
): Promise<OperationLock> {
  const filesystem = options.filesystem ?? new FilesystemService()
  const clock = options.clock ?? systemOperationClock
  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError('staleAfterMs must be a positive finite number')
  }
  const key = repositoryKey(options.repositoryRoot)
  const stateRoot = options.stateRoot ?? buildSkillboxHomeLayout(resolveSkillboxHome()).runtimeLocks
  const lockPath = operationLockPath(stateRoot, key)
  await filesystem.mkdir(path.dirname(lockPath))

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const now = clock.now()
      const record: OperationLockRecord = {
        version: 1,
        repositoryKey: key,
        owner: options.owner,
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + staleAfterMs).toISOString(),
      }
      if (!(await filesystem.writeFileExclusive(lockPath, JSON.stringify(record)))) {
        throw Object.assign(new Error('lock exists'), { code: 'EEXIST' })
      }
      return {
        record,
        path: lockPath,
        release: () => releaseOperationLock(lockPath, record, filesystem),
      }
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error
      }
      const existing = await readOperationLock(lockPath, filesystem)
      if (!isStaleOperationLock(existing, clock.now())) {
        throw new OperationLockError(
          'A mutation is already running for this repository',
          'LOCK_HELD',
          existing,
        )
      }
      await filesystem.remove(lockPath)
    }
  }
  throw new OperationLockError('A mutation is already running for this repository', 'LOCK_HELD')
}

export async function readOperationLock(
  lockPath: string,
  filesystem: FilesystemService = new FilesystemService(),
): Promise<OperationLockRecord | undefined> {
  try {
    const raw = await filesystem.readFile(lockPath)
    const parsed: unknown = JSON.parse(raw)
    if (!isLockRecord(parsed)) {
      throw new OperationLockError(`Invalid operation lock at "${lockPath}"`, 'LOCK_CORRUPT')
    }
    return parsed
  } catch (error) {
    if (isNotFound(error)) {
      return undefined
    }
    throw error
  }
}

export function isStaleOperationLock(
  record: OperationLockRecord | undefined,
  now: number,
): boolean {
  return record === undefined || Date.parse(record.expiresAt) <= now
}

async function releaseOperationLock(
  lockPath: string,
  expected: OperationLockRecord,
  filesystem: FilesystemService,
): Promise<void> {
  const actual = await readOperationLock(lockPath, filesystem)
  if (
    actual === undefined ||
    actual.owner.id !== expected.owner.id ||
    actual.acquiredAt !== expected.acquiredAt
  ) {
    throw new OperationLockError(
      'Operation lock ownership was lost before release',
      'LOCK_OWNERSHIP_LOST',
      actual,
    )
  }
  await filesystem.remove(lockPath)
}

function isLockRecord(value: unknown): value is OperationLockRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const owner = record['owner']
  return (
    record['version'] === 1 &&
    typeof record['repositoryKey'] === 'string' &&
    typeof record['acquiredAt'] === 'string' &&
    typeof record['expiresAt'] === 'string' &&
    typeof owner === 'object' &&
    owner !== null &&
    typeof (owner as Record<string, unknown>)['id'] === 'string' &&
    typeof (owner as Record<string, unknown>)['pid'] === 'number'
  )
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
  )
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'NOT_FOUND'
  )
}
