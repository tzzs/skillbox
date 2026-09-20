import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ErrorCode, SkillboxError } from '../errors.js'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { repositoryKey } from '../operations/sync-runtime-lock.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { parseConflictSession, serializeConflictSession } from './conflicts.js'
import type { ConflictSession } from './types.js'

export interface ConflictSessionStoreOptions {
  repositoryRoot: string
  homeRoot?: string
  now?: () => number
}

/**
 * Repository-scoped durable storage for user decisions.  Session records are
 * deliberately JSON-only and carry object IDs / relative paths, never a
 * filesystem root or transport credential.
 */
export class ConflictSessionStore {
  private readonly key: string
  private readonly sessionsRoot: string
  private readonly now: () => number

  constructor(options: ConflictSessionStoreOptions) {
    this.key = repositoryKey(path.resolve(options.repositoryRoot))
    this.sessionsRoot = buildSkillboxHomeLayout(
      options.homeRoot ?? resolveSkillboxHome(),
    ).syncSessions
    this.now = options.now ?? (() => Date.now())
  }

  async save(session: ConflictSession): Promise<void> {
    const serialized = serializeConflictSession(session)
    if (containsForbiddenSessionData(JSON.parse(serialized))) {
      throw new SkillboxError(
        ErrorCode.SYNC_INVALID_CONFLICT_RESOLUTION,
        'Conflict sessions cannot contain credentials or absolute paths',
        { recoverable: true },
      )
    }
    const record = parseConflictSession(JSON.parse(serialized))
    if (record.repositoryId !== this.key) {
      throw sessionError('This conflict session belongs to a different repository')
    }
    await atomicWriteFile(this.pathFor(record.id), `${serializeConflictSession(record)}\n`)
  }

  async get(id: string): Promise<ConflictSession> {
    assertId(id)
    let raw: string
    try {
      raw = await fs.readFile(this.pathFor(id), 'utf8')
    } catch (error) {
      throw sessionError('The requested conflict session no longer exists', error)
    }
    let record: unknown
    try {
      record = JSON.parse(raw)
    } catch (error) {
      throw sessionError('The conflict session is damaged', error)
    }
    const session = parseConflictSession(record)
    if (session.repositoryId !== this.key) {
      throw sessionError('This conflict session belongs to a different repository')
    }
    if (Date.parse(session.expiresAt) <= this.now()) {
      throw sessionError('The conflict session has expired')
    }
    return session
  }

  async list(): Promise<ConflictSession[]> {
    const directory = this.directory()
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw sessionError('Could not read conflict sessions', error)
    }
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          try {
            return await this.get(entry.name.slice(0, -'.json'.length))
          } catch (error) {
            if (error instanceof SkillboxError && error.message.includes('expired'))
              return undefined
            throw error
          }
        }),
    )
    return sessions.filter((session): session is ConflictSession => session !== undefined)
  }

  async delete(id: string): Promise<void> {
    assertId(id)
    await fs.rm(this.pathFor(id), { force: true })
  }

  async cleanExpired(): Promise<string[]> {
    const directory = this.directory()
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw sessionError('Could not clean conflict sessions', error)
    }
    const removed: string[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      try {
        const raw = await fs.readFile(this.pathFor(id), 'utf8')
        const record: unknown = JSON.parse(raw)
        const session = parseConflictSession(record)
        if (Date.parse(session.expiresAt) <= this.now()) {
          await this.delete(id)
          removed.push(id)
        }
      } catch {
        await this.delete(id)
        removed.push(id)
      }
    }
    return removed
  }

  private directory(): string {
    return path.join(this.sessionsRoot, this.key)
  }

  private pathFor(id: string): string {
    return path.join(this.directory(), `${id}.json`)
  }
}

function assertId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw sessionError('Invalid conflict-session identifier')
  }
}

function sessionError(message: string, cause?: unknown): SkillboxError {
  const code = message.includes('no longer exists')
    ? ErrorCode.SYNC_CONFLICT_SESSION_NOT_FOUND
    : ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED
  return new SkillboxError(code, message, { cause, recoverable: true })
}

function containsForbiddenSessionData(value: unknown, key = ''): boolean {
  if (/token|authorization|credential|password|secret/i.test(key)) return true
  if (typeof value === 'string') return path.isAbsolute(value)
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenSessionData(entry))
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([childKey, child]) =>
    containsForbiddenSessionData(child, childKey),
  )
}
