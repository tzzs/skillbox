import { ErrorCode, SkillboxError } from '../errors.js'
import type { SkillMode } from '../domain/skill.js'

export type LifecycleTransition = readonly [from: SkillMode, to: SkillMode]

/**
 * Legal lifecycle transitions (M17 / M18 state machine):
 *
 * - `managed → forked` (M17.1 fork)
 * - `managed → vendored` (M18.1 vendor)
 * - `forked → vendored` (M18.2 vendor)
 * - `forked → managed` (optional restore path, spec §87-89)
 *
 * `vendored` is a terminal state: content is frozen in the repository and no
 * upstream tracking remains, so it can never transition again. `local` skills
 * are outside the lifecycle (nothing to convert from or to).
 */
export const LEGAL_LIFECYCLE_TRANSITIONS: readonly LifecycleTransition[] = [
  ['managed', 'forked'],
  ['managed', 'vendored'],
  ['forked', 'vendored'],
  ['forked', 'managed'],
]

/** Whether the state machine permits `from → to`. */
export function canTransition(from: SkillMode, to: SkillMode): boolean {
  return LEGAL_LIFECYCLE_TRANSITIONS.some(
    ([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to,
  )
}

/**
 * Throws `LIFECYCLE_ILLEGAL_TRANSITION` when `from → to` is not a legal
 * lifecycle transition (or the source mode is not lifecycle-managed at all).
 */
export function assertLegalTransition(from: SkillMode, to: SkillMode, alias: string): void {
  if (!canTransition(from, to)) {
    throw new SkillboxError(
      ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
      `Skill "${alias}" cannot transition from ${from} to ${to}`,
      { context: { alias, from, to } },
    )
  }
}
