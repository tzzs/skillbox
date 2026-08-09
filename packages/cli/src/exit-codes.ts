import { isSkillboxError } from '@skillbox/core'
import { FsIoErrorCode, SkillboxFsError } from '@skillbox/core'

/**
 * M8.11 Exit Codes. Stable, machine-readable process exit statuses:
 *   0 success, 1 generic failure, 2 validation, 3 conflict, 4 security.
 */
export const ExitCode = {
  SUCCESS: 0,
  GENERIC: 1,
  VALIDATION: 2,
  CONFLICT: 3,
  SECURITY: 4,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

/** Config/data that is structurally invalid: bad manifest, lockfile, config. */
const VALIDATION_CODES = new Set<string>([
  'INVALID_SKILL',
  'INVALID_MANIFEST',
  'UNSUPPORTED_MANIFEST_VERSION',
  'INVALID_LOCKFILE',
  'UNSUPPORTED_LOCKFILE_VERSION',
  'INVALID_CONFIG',
  'INVALID_LINK_STATE',
  'LOCKFILE_OUTDATED',
  // V0.3 marketplace: bad/unknown source expressions and registry lookups
  // that come back empty are user-input problems, not infrastructure faults.
  'SOURCE_INVALID',
  'SOURCE_UNSUPPORTED',
  'REGISTRY_NOT_FOUND',
])

/** Two parties disagree over the same resource (duplicate, locked mismatch). */
const CONFLICT_CODES = new Set<string>([
  'IMPORT_CONFLICT',
  'AGENT_LINK_CONFLICT',
  'INTEGRITY_MISMATCH',
  'GIT_CONFLICT',
  'GIT_DIRTY',
  'GIT_PUSH_REJECTED',
  // V0.3 marketplace: install collides with an existing skill.
  'INSTALL_CONFLICT',
  // V0.4 lifecycle: a 3-way merge has unresolved conflicts (M20). CLI-level
  // code until agent 2 lands `MERGE_CONFLICT` in core's ErrorCode.
  'MERGE_CONFLICT',
])

/** Path traversal / unsafe links / blocked secrets: refuse before anything else. */
const SECURITY_CODES = new Set<string>([
  'UNSAFE_PATH',
  'UNSAFE_SYMLINK',
  'SECRET_FOUND',
  // V0.3 marketplace: a HIGH-risk skill install refused without confirmation.
  'INSTALL_SECURITY_BLOCKED',
])

/** Maps a Core error (or Commander/Zod error) to its stable exit code. */
export function exitCodeForError(error: unknown): ExitCode {
  if (!isSkillboxError(error)) {
    if (error instanceof SkillboxFsError) {
      if (error.code === FsIoErrorCode.ALREADY_EXISTS) {
        return ExitCode.CONFLICT
      }
      return ExitCode.GENERIC
    }
    return ExitCode.GENERIC
  }

  if (VALIDATION_CODES.has(error.code)) {
    return ExitCode.VALIDATION
  }
  if (CONFLICT_CODES.has(error.code)) {
    return ExitCode.CONFLICT
  }
  if (SECURITY_CODES.has(error.code)) {
    return ExitCode.SECURITY
  }
  return ExitCode.GENERIC
}
