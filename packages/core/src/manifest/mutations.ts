import { z } from 'zod'
import { SkillboxError, ErrorCode } from '../errors.js'
import {
  manifestSkillSchema,
  validateSkillAlias,
  type ManifestSkill,
  type ManifestSkillSource,
  type SkillboxManifest,
} from './schema.js'

export type ManifestSkillInput = Partial<Omit<ManifestSkill, 'source'>> & {
  source: ManifestSkillSource
}

function skillEntry(manifest: SkillboxManifest, alias: string): ManifestSkill {
  const entry = manifest.skills[alias]
  if (entry === undefined) {
    throw new SkillboxError(ErrorCode.SKILL_NOT_FOUND, `Skill "${alias}" is not in the manifest`, {
      context: { alias },
    })
  }
  return entry
}

const agentsSchema = z.array(z.string().min(1))

/**
 * Adds a skill to the manifest. Returns a new manifest object; the caller is
 * responsible for persisting it with `writeManifest`.
 */
export function addSkill(
  manifest: SkillboxManifest,
  alias: string,
  input: ManifestSkillInput,
): SkillboxManifest {
  const key = validateSkillAlias(alias)
  if (manifest.skills[key] !== undefined) {
    throw new SkillboxError(
      ErrorCode.INVALID_MANIFEST,
      `Skill "${key}" already exists in the manifest`,
      { context: { alias: key } },
    )
  }
  const parsed = manifestSkillSchema.parse(input)
  return { ...manifest, skills: { ...manifest.skills, [key]: parsed } }
}

/** Removes a skill from the manifest and returns the new manifest object. */
export function removeSkill(manifest: SkillboxManifest, alias: string): SkillboxManifest {
  const key = validateSkillAlias(alias)
  skillEntry(manifest, key)
  const skills = { ...manifest.skills }
  delete skills[key]
  return { ...manifest, skills }
}

/**
 * Merges `patch` over the existing skill entry and returns a new manifest
 * object. Allowed to update any field, including `source`.
 */
export function updateSkill(
  manifest: SkillboxManifest,
  alias: string,
  patch: Partial<ManifestSkill>,
): SkillboxManifest {
  const key = validateSkillAlias(alias)
  const current = skillEntry(manifest, key)
  const next = { ...current, ...patch }
  const parsed = manifestSkillSchema.parse(next)
  return { ...manifest, skills: { ...manifest.skills, [key]: parsed } }
}

/**
 * Sets which agents a skill is enabled for (skill-level `agents` array).
 * An empty array means the skill is installed but not exposed to any agent.
 */
export function setAgents(
  manifest: SkillboxManifest,
  alias: string,
  agents: string[],
): SkillboxManifest {
  const key = validateSkillAlias(alias)
  const current = skillEntry(manifest, key)
  const parsedAgents = agentsSchema.parse(agents)
  const next = { ...current, agents: parsedAgents }
  const parsed = manifestSkillSchema.parse(next)
  return { ...manifest, skills: { ...manifest.skills, [key]: parsed } }
}
