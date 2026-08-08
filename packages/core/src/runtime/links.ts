import { z } from 'zod'
import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { SkillboxError, ErrorCode } from '../errors.js'

export const LINKS_FILE_NAME = 'links.json'

export const runtimeLinkRecordSchema = z.object({
  strategy: z.enum(['symlink', 'junction', 'copy']),
  source: z.string().min(1),
  target: z.string().min(1),
})

export type RuntimeLinkRecord = z.infer<typeof runtimeLinkRecordSchema>

/**
 * Database shape of `~/.skillbox/state/links.json`:
 * `{ [agentId]: { [skillAlias]: { strategy, source, target } } }`.
 * Where a record exists, the Agent skills directory entry is owned by
 * Skillbox (Ownership Marker, SKILLBOX_SPEC.md §132).
 */
export type RuntimeLinksDatabase = Record<string, Record<string, RuntimeLinkRecord>>

/** Normalizes an absolute path for case-insensitive cross-platform compare. */
export function normalizePathForCompare(target: string): string {
  const normalized = path.normalize(path.resolve(target))
  if (process.platform === 'win32') {
    return normalized.toLowerCase()
  }
  return normalized
}

/**
 * Whether any recorded link `target` equals `targetPath`. This is the
 * Ownership Marker fallback (SKILLBOX_SPEC.md §132): a link recorded in
 * `state/links.json` is owned by Skillbox even when the physical layout uses
 * a plain `copy` (whose realpath stays in the agent directory).
 */
export function hasRecordedTarget(database: RuntimeLinksDatabase, targetPath: string): boolean {
  const needle = normalizePathForCompare(targetPath)
  for (const row of Object.values(database)) {
    for (const record of Object.values(row)) {
      if (record !== undefined && needle === normalizePathForCompare(record.target)) {
        return true
      }
    }
  }
  return false
}

export const runtimeLinksDatabaseSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), runtimeLinkRecordSchema),
)

/** Deterministic serialization (sorted keys) so unchanged state writes nothing. */
export function serializeLinksDatabase(database: RuntimeLinksDatabase): string {
  const agentIds = Object.keys(database).sort()
  const out: Record<string, Record<string, RuntimeLinkRecord>> = {}
  for (const agent of agentIds) {
    const aliases = database[agent] ?? {}
    const row: Record<string, RuntimeLinkRecord> = {}
    for (const alias of Object.keys(aliases).sort()) {
      const record = aliases[alias]
      if (record !== undefined) {
        row[alias] = { strategy: record.strategy, source: record.source, target: record.target }
      }
    }
    out[agent] = row
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

export interface RuntimeLinkStateOptions {
  filesystem?: FilesystemService
  /** Absolute path of `state/links.json`. */
  filePath: string
}

export interface SaveLinksResult {
  /** True when the file was rewritten, false when it already matched. */
  changed: boolean
}

/**
 * Runtime State (M6.4): records Skillbox-created Agent Links so Reconcile
 * knows exactly which links can be removed safely and which are external.
 */
export class RuntimeLinkState {
  private readonly filesystem: FilesystemService
  readonly filePath: string

  constructor(options: RuntimeLinkStateOptions) {
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.filePath = options.filePath
  }

  async load(): Promise<RuntimeLinksDatabase> {
    if (!(await this.filesystem.exists(this.filePath))) {
      return {}
    }
    let document: unknown
    try {
      document = JSON.parse(await this.filesystem.readFile(this.filePath))
    } catch (error) {
      throw new SkillboxError(
        ErrorCode.INVALID_LINK_STATE,
        `Invalid links state at "${this.filePath}"`,
        {
          cause: error,
          context: { path: this.filePath },
        },
      )
    }
    const result = runtimeLinksDatabaseSchema.safeParse(document)
    if (!result.success) {
      throw new SkillboxError(
        ErrorCode.INVALID_LINK_STATE,
        `Invalid links state at "${this.filePath}"`,
        {
          context: { path: this.filePath, issues: result.error.issues },
        },
      )
    }
    return result.data
  }

  /** Persists the database only when its serialized form changed. */
  async save(database: RuntimeLinksDatabase): Promise<SaveLinksResult> {
    const serialized = serializeLinksDatabase(database)
    let changed = true
    if (await this.filesystem.exists(this.filePath)) {
      changed = (await this.filesystem.readFile(this.filePath)) !== serialized
    }
    if (changed) {
      await this.filesystem.mkdir(path.dirname(this.filePath))
      await this.filesystem.writeFile(this.filePath, serialized)
    }
    return { changed }
  }

  /**
   * Adds/updates a record and persists the new database, returning whether it
   * changed on disk.
   */
  async set(
    agent: string,
    alias: string,
    record: RuntimeLinkRecord,
    database?: RuntimeLinksDatabase,
  ): Promise<{ database: RuntimeLinksDatabase; changed: boolean }> {
    const current = database ?? (await this.load())
    const existingAgent = current[agent] ?? {}
    const existing = existingAgent[alias]
    const sameRecord =
      existing !== undefined &&
      existing.strategy === record.strategy &&
      existing.source === record.source &&
      existing.target === record.target
    if (!sameRecord) {
      current[agent] = { ...existingAgent, [alias]: { ...record } }
      const { changed } = await this.save(current)
      return { database: current, changed }
    }
    return { database: current, changed: false }
  }

  /**
   * Records a link difference compared to equality by value. Returns the
   * updated database.
   */
  async remove(
    agent: string,
    alias: string,
    database?: RuntimeLinksDatabase,
  ): Promise<{ database: RuntimeLinksDatabase; changed: boolean }> {
    const current = database ?? (await this.load())
    const existingAgent = current[agent]
    if (existingAgent === undefined || existingAgent[alias] === undefined) {
      return { database: current, changed: false }
    }
    const row = { ...existingAgent }
    delete row[alias]
    if (Object.keys(row).length === 0) {
      const copy = { ...current }
      delete copy[agent]
      const { changed } = await this.save(copy)
      return { database: copy, changed }
    }
    const next = { ...current, [agent]: row }
    const { changed } = await this.save(next)
    return { database: next, changed }
  }

  /**
   * True when any recorded link currently targets `targetPath` (path-based
   * Ownership Marker lookup used by link cleanup).
   */
  async isOwnedPath(targetPath: string): Promise<boolean> {
    const database = await this.load()
    return hasRecordedTarget(database, targetPath)
  }
}

export interface RuntimeLinkStateOptions {
  filesystem?: FilesystemService
  /** Location of `state/links.json`. */
  filePath: string
}
