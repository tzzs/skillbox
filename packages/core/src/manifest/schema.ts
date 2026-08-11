import { z } from 'zod'
import type { SkillMode } from '../domain/skill.js'
import { SkillboxError, ErrorCode } from '../errors.js'

/** Manifest schema version (`version:` in skillbox.yaml). */
export const MANIFEST_VERSION = 1 as const

/** File name of the Manifest inside a repository root. */
export const MANIFEST_FILE_NAME = 'skillbox.yaml'

export const skillModeSchema = z.enum(['managed', 'forked', 'local', 'vendored'])

const nonEmptyString = (): z.ZodString => z.string().trim().min(1, 'must not be empty')

export const githubManifestSourceSchema = z.object({
  type: z.literal('github'),
  repo: nonEmptyString(),
  path: nonEmptyString().optional(),
  ref: nonEmptyString().optional(),
})

export const gitManifestSourceSchema = z.object({
  type: z.literal('git'),
  url: nonEmptyString(),
  path: nonEmptyString().optional(),
  ref: nonEmptyString().optional(),
})

export const registryManifestSourceSchema = z.object({
  type: z.literal('registry'),
  registry: nonEmptyString(),
  package: nonEmptyString(),
  version: nonEmptyString().optional(),
})

export const localManifestSourceSchema = z.object({
  type: z.literal('local'),
  path: nonEmptyString(),
})

export const manifestSourceSchema = z.discriminatedUnion('type', [
  githubManifestSourceSchema,
  gitManifestSourceSchema,
  registryManifestSourceSchema,
  localManifestSourceSchema,
])

export type ManifestSkillSource = z.infer<typeof manifestSourceSchema>

function isLocalSource(source: ManifestSkillSource): boolean {
  return source.type === 'local'
}

/**
 * Mode is derived from the source when not specified explicitly:
 * `local` source → `local` mode, any remote source → `managed`.
 */
export function deriveMode(skill: {
  source: ManifestSkillSource
  mode?: SkillMode | undefined
}): SkillMode {
  if (skill.mode !== undefined) {
    return skill.mode
  }
  return isLocalSource(skill.source) ? 'local' : 'managed'
}

export const manifestSkillSchema = z
  .object({
    source: manifestSourceSchema,
    mode: skillModeSchema.optional(),
    upstream: manifestSourceSchema.optional(),
    agents: z.array(nonEmptyString()).optional(),
    enabled: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((skill, ctx) => {
    const mode = deriveMode(skill)
    const hasUpstream = skill.upstream !== undefined

    if (mode === 'managed' && isLocalSource(skill.source)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'managed mode requires a remote source, got local',
        path: ['source', 'type'],
      })
    }
    if (mode === 'forked') {
      if (!isLocalSource(skill.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'forked mode requires a local source',
          path: ['source', 'type'],
        })
      }
      if (!hasUpstream) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'forked mode requires an upstream source',
          path: ['upstream'],
        })
      }
    }
    if (mode === 'local' && !isLocalSource(skill.source)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'local mode requires a local source',
        path: ['source', 'type'],
      })
    }
    if (mode === 'local' && hasUpstream) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'local mode cannot declare an upstream',
        path: ['upstream'],
      })
    }
    if (mode === 'vendored') {
      if (!isLocalSource(skill.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'vendored mode requires a local source',
          path: ['source', 'type'],
        })
      }
      if (hasUpstream) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'vendored mode cannot declare an upstream',
          path: ['upstream'],
        })
      }
    }
  })

export type ManifestSkill = z.infer<typeof manifestSkillSchema>

export const manifestAgentConfigSchema = z.object({
  enabled: z.boolean().optional(),
})

export type ManifestAgentConfig = z.infer<typeof manifestAgentConfigSchema>

export const manifestSettingsSchema = z.object({
  defaultAgents: z.array(nonEmptyString()).optional(),
})

export type ManifestSettings = z.infer<typeof manifestSettingsSchema>

export const skillboxManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  name: nonEmptyString().optional(),
  description: nonEmptyString().optional(),
  skills: z.record(z.string(), manifestSkillSchema),
  agents: z.record(z.string(), manifestAgentConfigSchema).optional(),
  settings: manifestSettingsSchema.optional(),
})

export type SkillboxManifest = z.infer<typeof skillboxManifestSchema>

export function emptyManifest(): SkillboxManifest {
  return { version: MANIFEST_VERSION, skills: {} }
}

/**
 * Validates a Skill Alias against the recommended `^[a-z0-9][a-z0-9-_]*$`
 * format and returns it unchanged on success.
 */
export function validateSkillAlias(alias: string): string {
  const ALIAS_RE = /^[a-z0-9][a-z0-9-_]*$/
  if (!ALIAS_RE.test(alias)) {
    throw new SkillboxError(
      ErrorCode.INVALID_MANIFEST,
      `Invalid skill alias "${alias}" (must match ${ALIAS_RE.source})`,
      { context: { alias } },
    )
  }
  return alias
}
