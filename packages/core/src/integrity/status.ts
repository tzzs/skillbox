import type { SkillStatus } from '../domain/skill.js'
import { computeSkillIntegrity } from './canonical-hash.js'

/** Result type of Local Modification Detection (M4.5). */
export type ModificationStatus = Extract<SkillStatus, 'ready' | 'modified'>

/**
 * Compares a freshly computed skill integrity against the integrity recorded
 * in the lockfile. Same hash => `ready`, anything else => `modified`.
 */
export function compareIntegrity(current: string, locked: string): ModificationStatus {
  return current === locked ? 'ready' : 'modified'
}

/**
 * Computes the current integrity of `skillRoot` and compares it against the
 * locked integrity. Convenience wrapper for Local Modification Detection.
 */
export async function detectLocalModification(
  skillRoot: string,
  lockedIntegrity: string,
): Promise<ModificationStatus> {
  const current = await computeSkillIntegrity(skillRoot)
  return compareIntegrity(current, lockedIntegrity)
}
