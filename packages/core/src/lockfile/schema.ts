import { z } from 'zod'
import { manifestSourceSchema } from '../manifest/schema.js'
import type { SecurityMetadata } from '../security/types.js'

/** Lockfile schema version (`lockfileVersion:` in skillbox.lock). */
export const LOCKFILE_VERSION = 1 as const

/** File name of the Lockfile inside a repository root. */
export const LOCKFILE_FILE_NAME = 'skillbox.lock'

const nonEmptyString = (): z.ZodString => z.string().trim().min(1, 'must not be empty')

/**
 * Supported lock modes for wave 1. `managed` and `local` are active today;
 * `forked` / `vendored` are schema-complete for the next waves.
 */
export const lockedModeSchema = z.enum(['managed', 'local', 'forked', 'vendored'])

export type LockedMode = z.infer<typeof lockedModeSchema>

export const lockedUpstreamSchema = z.object({
  source: manifestSourceSchema,
  baseRevision: nonEmptyString(),
  baseIntegrity: nonEmptyString().optional(),
  latestRevision: nonEmptyString().optional(),
})

export type LockedUpstream = z.infer<typeof lockedUpstreamSchema>

/**
 * Security metadata recorded for a locked skill (SPEC §117 / GAP_ANALYSIS §5):
 * the static-scan risk rating and when it was taken. Reserved field of the
 * Lockfile contract — optional so lockfiles written before V0.3 stay valid.
 * The type is the security module's `SecurityMetadata` (kept as a type-only
 * import so both modules share one source of truth).
 */
export const securityMetadataSchema: z.ZodType<SecurityMetadata> = z.object({
  risk: z.enum(['low', 'medium', 'high']),
  scannedAt: z.string(),
})

export const lockedSkillSchema = z.object({
  mode: lockedModeSchema,
  source: manifestSourceSchema,
  revision: nonEmptyString().optional(),
  integrity: nonEmptyString(),
  upstream: lockedUpstreamSchema.optional(),
  security: securityMetadataSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type LockedSkill = z.infer<typeof lockedSkillSchema>

export const skillboxLockfileSchema = z.object({
  lockfileVersion: z.literal(LOCKFILE_VERSION),
  generatedBy: nonEmptyString().optional(),
  skills: z.record(z.string(), lockedSkillSchema),
})

export type SkillboxLockfile = z.infer<typeof skillboxLockfileSchema>

/** Returns a minimal, valid lockfile with no locked skills. */
export function emptyLockfile(options: { generatedBy?: string } = {}): SkillboxLockfile {
  const lockfile: SkillboxLockfile = { lockfileVersion: LOCKFILE_VERSION, skills: {} }
  if (options.generatedBy !== undefined) {
    lockfile.generatedBy = options.generatedBy
  }
  return lockfile
}

export function createLockedSkill(input: {
  mode: LockedMode
  source: LockedSkill['source']
  integrity: string
  revision?: string
  metadata?: Record<string, unknown>
}): LockedSkill {
  const value: LockedSkill = { mode: input.mode, source: input.source, integrity: input.integrity }
  if (input.revision !== undefined) value.revision = input.revision
  if (input.metadata !== undefined) value.metadata = input.metadata
  return value
}
