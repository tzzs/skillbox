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
])

/** Two parties disagree over the same resource (duplicate, locked mismatch). */
const CONFLICT_CODES = new Set<string>([
  'IMPORT_CONFLICT',
  'AGENT_LINK_CONFLICT',
  'INTEGRITY_MISMATCH',
])

/** Path traversal / unsafe links: refuse before doing anything else. */
const SECURITY_CODES = new Set<string>(['UNSAFE_PATH', 'UNSAFE_SYMLINK'])

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
