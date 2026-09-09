import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ErrorCode, SkillboxError } from '../errors.js'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { repositoryKey } from '../operations/sync-runtime-lock.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'

const SNAPSHOT_VERSION = 1 as const
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000
const MANAGED_PATHS = ['skillbox.yaml', 'skillbox.lock', 'skills'] as const

export interface SnapshotGitPort {
  revParse(repositoryRoot: string, revision: string): Promise<string>
  createPrivateRef(repositoryRoot: string, name: string, revision: string): Promise<void>
  deletePrivateRef(repositoryRoot: string, name: string): Promise<void>
}

export interface SyncSnapshot {
  version: typeof SNAPSHOT_VERSION
  id: string
  repositoryKey: string
  repositoryIdentity: string
  createdAt: string
  expiresAt: string
  /** Private ref retaining the pre-transaction commit; never a remote URL. */
  ref: string
  revision: string
  managedPaths: readonly string[]
  metadata?: Record<string, unknown>
}

export interface SnapshotServiceOptions {
  repositoryRoot: string
  git: SnapshotGitPort
  homeRoot?: string
  now?: () => number
  expiryMs?: number
}

export interface CreateSnapshotOptions {
  id?: string
  metadata?: Record<string, unknown>
}

/**
 * Restorable checkpoint for the repository-owned portion of a sync.  Payloads
 * intentionally only include managed paths, so a restore never overwrites a
 * user's unrelated files.
 */
export class SnapshotService {
  private readonly repositoryRoot: string
  private readonly git: SnapshotGitPort
  private readonly snapshotsRoot: string
  private readonly key: string
  private readonly identity: string
  private readonly now: () => number
  private readonly expiryMs: number

  constructor(options: SnapshotServiceOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot)
    this.git = options.git
    this.snapshotsRoot = buildSkillboxHomeLayout(
      options.homeRoot ?? resolveSkillboxHome(),
    ).syncSnapshots
    this.key = repositoryKey(this.repositoryRoot)
    this.identity = this.key
    this.now = options.now ?? (() => Date.now())
    this.expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS
  }

  async create(options: CreateSnapshotOptions = {}): Promise<SyncSnapshot> {
    const id = options.id ?? randomUUID()
    assertSafeId(id)
    const revision = await this.git.revParse(this.repositoryRoot, 'HEAD')
    const ref = `refs/skillbox/snapshots/${id}`
    const createdAt = new Date(this.now()).toISOString()
    const snapshot: SyncSnapshot = {
      version: SNAPSHOT_VERSION,
      id,
      repositoryKey: this.key,
      repositoryIdentity: this.identity,
      createdAt,
      expiresAt: new Date(this.now() + this.expiryMs).toISOString(),
      ref,
      revision,
      managedPaths: MANAGED_PATHS,
      ...(options.metadata === undefined ? {} : { metadata: sanitizedMetadata(options.metadata) }),
    }
    const directory = this.directoryFor(id)
    try {
      await this.git.createPrivateRef(this.repositoryRoot, ref, revision)
      await fs.mkdir(directory, { recursive: true })
      for (const managedPath of MANAGED_PATHS) {
        await capturePath(
          resolveInsideRoot(this.repositoryRoot, managedPath),
          path.join(directory, 'payload', managedPath),
        )
      }
      await atomicWriteFile(this.snapshotPath(id), `${JSON.stringify(snapshot)}\n`)
      return snapshot
    } catch (error) {
      await this.git.deletePrivateRef(this.repositoryRoot, ref).catch(() => undefined)
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
      throw restoreError('Could not create a sync restore point', error)
    }
  }

  async get(id: string): Promise<SyncSnapshot> {
    assertSafeId(id)
    let raw: string
    try {
      raw = await fs.readFile(this.snapshotPath(id), 'utf8')
    } catch (error) {
      throw new SkillboxError(
        ErrorCode.SYNC_SNAPSHOT_NOT_FOUND,
        'The requested sync restore point no longer exists',
        { cause: error, recoverable: true },
      )
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw restoreError('The sync restore point is damaged', error)
    }
    if (!isSyncSnapshot(value)) throw restoreError('The sync restore point is invalid')
    if (value.repositoryKey !== this.key || value.repositoryIdentity !== this.identity) {
      throw restoreError('This restore point belongs to a different repository')
    }
    if (Date.parse(value.expiresAt) <= this.now()) {
      throw restoreError('This sync restore point has expired')
    }
    return value
  }

  async restore(id: string): Promise<void> {
    const snapshot = await this.get(id)
    const directory = this.directoryFor(snapshot.id)
    try {
      for (const managedPath of snapshot.managedPaths) {
        const target = resolveInsideRoot(this.repositoryRoot, managedPath)
        const payload = path.join(directory, 'payload', managedPath)
        await fs.rm(target, { recursive: true, force: true })
        if (await pathExists(payload)) {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.cp(payload, target, { recursive: true, force: true, dereference: false })
        }
      }
      await this.git.createPrivateRef(this.repositoryRoot, snapshot.ref, snapshot.revision)
    } catch (error) {
      throw restoreError(`Could not restore sync restore point "${snapshot.id}"`, error)
    }
  }

  async remove(id: string): Promise<void> {
    const snapshot = await this.get(id)
    await this.git.deletePrivateRef(this.repositoryRoot, snapshot.ref)
    await fs.rm(this.directoryFor(id), { recursive: true, force: true })
  }

  private directoryFor(id: string): string {
    return path.join(this.snapshotsRoot, this.key, id)
  }

  private snapshotPath(id: string): string {
    return path.join(this.directoryFor(id), 'snapshot.json')
  }
}

function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.version === SNAPSHOT_VERSION &&
    typeof record.id === 'string' &&
    typeof record.repositoryKey === 'string' &&
    typeof record.repositoryIdentity === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.expiresAt === 'string' &&
    typeof record.ref === 'string' &&
    typeof record.revision === 'string' &&
    Array.isArray(record.managedPaths) &&
    record.managedPaths.every((entry) => MANAGED_PATHS.includes(entry))
  )
}

async function capturePath(source: string, destination: string): Promise<void> {
  if (!(await pathExists(source))) return
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(source, destination, { recursive: true, force: true, dereference: false })
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function assertSafeId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new SkillboxError(ErrorCode.UNSAFE_PATH, 'Invalid sync restore-point identifier')
  }
}

function sanitizedMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(metadata, (key, value) =>
    /token|authorization|credential|password|secret/i.test(key) ? undefined : value,
  )
  return JSON.parse(serialized) as Record<string, unknown>
}

function restoreError(message: string, cause?: unknown): SkillboxError {
  return new SkillboxError(ErrorCode.SYNC_SNAPSHOT_RESTORE_FAILED, message, {
    cause,
    recoverable: true,
  })
}
