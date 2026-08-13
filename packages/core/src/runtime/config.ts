import { z } from 'zod'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { SkillboxError, ErrorCode } from '../errors.js'

export const linkStrategySchema = z.enum(['auto', 'symlink', 'junction', 'copy'])

export const runtimeConfigSchema = z.object({
  /** Absolute path of the Repository this machine is wired to. */
  repository: z.string().min(1).optional(),
  /** How Skillbox links skills into agent skill directories. */
  linkStrategy: linkStrategySchema.optional(),
  web: z
    .object({
      /** Interface to bind when a caller elects to read this setting. */
      host: z.string().trim().min(1).optional(),
      port: z.number().int().positive().optional(),
      open: z.boolean().optional(),
    })
    .optional(),
  /** Per-agent path overrides (e.g. `{"claude": {"path": "/x/claude"}}`). */
  agents: z
    .record(
      z.string().min(1),
      z.object({
        /** Legacy single-directory override retained for older config files. */
        path: z.string().min(1).optional(),
        /** Explicit skill directories, for agents that support more than one location. */
        skillDirectories: z.array(z.string().trim().min(1)).min(1).optional(),
        executable: z.string().min(1).optional(),
      }),
    )
    .optional(),
  /**
   * GitHub connection metadata (SPEC §125.1). Machine-local connection state;
   * only non-sensitive fields live here. Tokens and expiry stay in the OS
   * Credential Store and are forbidden in this block.
   */
  github: z
    .object({
      connected: z.boolean().optional(),
      login: z.string().min(1).optional(),
      provider: z.string().min(1).optional(),
      repository: z.string().min(1).optional(),
    })
    .optional(),
})

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

export interface RuntimeConfigServiceOptions {
  filesystem?: FilesystemService
  /** Absolute path of `config.json` (derived from the Skillbox Home). */
  configFilePath: string
}

function emptyConfig(): RuntimeConfig {
  return {}
}

function sortObjectRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key] as T
  }
  return out
}

function sortConfig(config: RuntimeConfig): RuntimeConfig {
  const out: RuntimeConfig = {}
  if (config.repository !== undefined) out.repository = config.repository
  if (config.linkStrategy !== undefined) out.linkStrategy = config.linkStrategy
  if (config.web !== undefined) out.web = { ...config.web }
  if (config.agents !== undefined) out.agents = sortObjectRecord(config.agents)
  if (config.github !== undefined) out.github = { ...config.github }
  return out
}

/**
 * Deterministic serialization: pretty JSON with sorted top-level keys, so an
 * unchanged config produces byte-identical bytes (idempotency-friendly).
 */
export function serializeRuntimeConfig(config: RuntimeConfig): string {
  return `${JSON.stringify(sortConfig(config), null, 2)}\n`
}

/**
 * Machine-specific runtime config stored at `~/.skillbox/config.json`.
 * Holds `repository`, `linkStrategy`, web options and per-agent path
 * overrides - never tracked by Git (they never enter the Repository).
 */
export class RuntimeConfigService {
  readonly configFilePath: string
  private readonly filesystem: FilesystemService

  constructor(options: RuntimeConfigServiceOptions) {
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.configFilePath = options.configFilePath
  }

  /** Reads and validates the config; a missing file yields the empty config. */
  async load(pathOverride?: string): Promise<RuntimeConfig> {
    const filePath = pathOverride ?? this.configFilePath
    if (!(await this.filesystem.exists(filePath))) {
      return emptyConfig()
    }
    let document: unknown
    try {
      document = JSON.parse(await this.filesystem.readFile(filePath))
    } catch (error) {
      throw new SkillboxError(ErrorCode.INVALID_CONFIG, `Failed to parse "${filePath}"`, {
        cause: error,
        context: { path: filePath },
      })
    }
    const result = runtimeConfigSchema.safeParse(document)
    if (!result.success) {
      throw new SkillboxError(ErrorCode.INVALID_CONFIG, `Invalid runtime config at "${filePath}"`, {
        context: { path: filePath, issues: result.error.issues },
      })
    }
    return result.data
  }

  /**
   * Atomically writes the config, skipping the write when nothing changed so
   * repeated saves are no-ops.
   */
  async save(config: RuntimeConfig, pathOverride?: string): Promise<void> {
    const filePath = pathOverride ?? this.configFilePath
    const serialized = serializeRuntimeConfig(config)
    if (await this.filesystem.exists(filePath)) {
      if ((await this.filesystem.readFile(filePath)) === serialized) {
        return
      }
    }
    await atomicWriteFile(filePath, serialized)
  }

  /** Merges a partial update into the persisted config. */
  async update(patch: RuntimeConfig): Promise<RuntimeConfig> {
    const current = await this.load()
    const next = { ...current, ...patch }
    await this.save(next)
    return next
  }
}
