import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { ErrorCode, SkillboxError } from '../errors.js'
import { resolveSkillboxHome } from '../runtime/paths.js'
import { OperationJournal } from './journal.js'

/** Default lock age after which a lock is treated as stale (10 minutes). */
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1_000

/** Default retry budget when a stale lock is being broken (10 × 50ms). */
export const DEFAULT_LOCK_RETRY_MS = 50
export const DEFAULT_LOCK_MAX_RETRIES = 10

export interface RuntimeLockOptions {
  /** Skillbox home root; the lock lives under `<home>/state/locks/`. */
  homeRoot?: string
  filesystem?: FilesystemService
  /** Lock age threshold for stale detection. */
  staleAfterMs?: number
  /** Retry sleep between stale-break attempts. */
  retryMs?: number
  /** Max retries after breaking a stale lock. */
  maxRetries?: number
  now?: () => number
  hostname?: () => string
  pid?: number
  /** Optional durable operation journal for crash recovery. */
  journal?: OperationJournal
}

export interface RuntimeLockOwner {
  pid: number
  hostname: string
  createdAt: number
  /** Short human description of the operation (diagnostics only). */
  operation?: string
}

export interface RuntimeLockHandle {
  readonly name: string
  readonly owner: RuntimeLockOwner
  /** Removes the lock file only when this process still owns it. */
  release(completed?: boolean): Promise<void>
}

function serializeOwner(owner: RuntimeLockOwner): string {
  return `${JSON.stringify(owner, null, 2)}\n`
}

function parseOwner(content: string): RuntimeLockOwner | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<RuntimeLockOwner> | null
    if (
      parsed !== null &&
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.createdAt === 'number'
    ) {
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        createdAt: parsed.createdAt,
        ...(typeof parsed.operation === 'string' ? { operation: parsed.operation } : {}),
      }
    }
  } catch {
    // fall through
  }
  return undefined
}

function lockDirOf(homeRoot: string): string {
  return path.join(homeRoot, 'state', 'locks')
}

function lockPathOf(homeRoot: string, name: string): string {
  return path.join(lockDirOf(homeRoot), `${name}.lock`)
}

/**
 * M8.x / roadmap 5.1 cross-process mutation lock.
 *
 * Mutating operations (install / sync / add / update / fork / vendor /
 * restore / merge / remove / create) acquire the same named lock file under
 * `<home>/state/locks/<name>.lock` so concurrent CLI / Web processes cannot
 * corrupt the Manifest / Lockfile / library / merge state.
 *
 * The lock file is created atomically (`O_EXCL`) with owner metadata
 * (`pid` / `hostname` / `createdAt`). A lock older than `staleAfterMs` is
 * broken (removed) and the acquisition retried — a crashed process can never
 * wedge the runtime. Releasing verifies the file still belongs to this
 * process before removing it.
 */
export async function acquireRuntimeLock(
  name: string,
  options: RuntimeLockOptions = {},
): Promise<RuntimeLockHandle> {
  const homeRoot = path.resolve(options.homeRoot ?? resolveSkillboxHome())
  const filesystem = options.filesystem ?? new FilesystemService()
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS
  const maxRetries = options.maxRetries ?? DEFAULT_LOCK_MAX_RETRIES
  const now = options.now ?? Date.now
  const hostname = options.hostname ?? os.hostname
  const pid = options.pid ?? process.pid

  const owner: RuntimeLockOwner = {
    pid,
    hostname: hostname(),
    createdAt: now(),
    operation: name,
  }
  const lockFile = lockPathOf(homeRoot, name)
  const journal = options.journal
  const journalRecord = journal === undefined ? undefined : await journal.begin(name)

  for (let attempt = 0; ; attempt += 1) {
    await filesystem.mkdir(lockDirOf(homeRoot))
    try {
      await fs.writeFile(lockFile, serializeOwner(owner), { flag: 'wx' })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw new SkillboxError(ErrorCode.RUNTIME_LOCKED, `Failed to acquire lock "${name}"`, {
          cause: error,
          context: { lock: lockFile },
        })
      }
    }

    // Lock exists — decide stale vs live.
    const existingOwner = await readOwner(filesystem, lockFile)
    if (existingOwner !== undefined && now() - existingOwner.createdAt < staleAfterMs) {
      throw new SkillboxError(
        ErrorCode.RUNTIME_LOCKED,
        `Another skillbox process (pid ${existingOwner.pid} on ${existingOwner.hostname}) is running "${existingOwner.operation ?? name}"; wait for it to finish and retry`,
        {
          recoverable: true,
          context: { lock: lockFile, owner: existingOwner },
        },
      )
    }
    // Stale lock (or unreadable owner file): break it and retry.
    await filesystem.remove(lockFile)
    if (attempt >= maxRetries) {
      throw new SkillboxError(
        ErrorCode.RUNTIME_LOCKED,
        `Lock "${name}" could not be acquired after breaking a stale lock ${maxRetries} times`,
        { recoverable: true, context: { lock: lockFile } },
      )
    }
    await sleep(retryMs)
  }

  return {
    name,
    owner,
    release: async (completed = true) => {
      await releaseRuntimeLock(homeRoot, name, owner, filesystem)
      if (journalRecord !== undefined) {
        await journal?.update(journalRecord.id, {
          state: completed ? 'completed' : 'failed',
        })
      }
    },
  }
}

async function readOwner(
  filesystem: FilesystemService,
  lockFile: string,
): Promise<RuntimeLockOwner | undefined> {
  try {
    return parseOwner(await filesystem.readFile(lockFile))
  } catch {
    return undefined
  }
}

async function releaseRuntimeLock(
  homeRoot: string,
  name: string,
  owner: RuntimeLockOwner,
  filesystem: FilesystemService,
): Promise<void> {
  const lockFile = lockPathOf(homeRoot, name)
  const current = await readOwner(filesystem, lockFile)
  if (current === undefined) {
    return // already released (e.g. broken as stale by another process)
  }
  if (current.pid !== owner.pid || current.createdAt !== owner.createdAt) {
    // The lock moved on (stale-broken and re-acquired); do not remove it.
    return
  }
  await filesystem.remove(lockFile)
}

/**
 * Runs `fn` while holding the named runtime lock; the lock is always
 * released (even when `fn` throws). See {@link acquireRuntimeLock}.
 */
export async function withRuntimeLock<T>(
  name: string,
  fn: () => Promise<T>,
  options: RuntimeLockOptions = {},
): Promise<T> {
  const journal =
    options.journal ??
    new OperationJournal(options.homeRoot === undefined ? {} : { homeRoot: options.homeRoot })
  await journal.recoverUnfinished()
  const handle = await acquireRuntimeLock(name, { ...options, journal })
  try {
    const result = await fn()
    await handle.release(true)
    return result
  } catch (error) {
    await handle.release(false)
    throw error
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { lockDirOf, lockPathOf }
