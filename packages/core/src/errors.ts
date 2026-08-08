export const ErrorCode = {
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  INVALID_SKILL: 'INVALID_SKILL',
  AGENT_NOT_DETECTED: 'AGENT_NOT_DETECTED',
  GIT_NOT_FOUND: 'GIT_NOT_FOUND',
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  MANIFEST_NOT_FOUND: 'MANIFEST_NOT_FOUND',
  UNSUPPORTED_MANIFEST_VERSION: 'UNSUPPORTED_MANIFEST_VERSION',
  INVALID_LOCKFILE: 'INVALID_LOCKFILE',
  LOCKFILE_NOT_FOUND: 'LOCKFILE_NOT_FOUND',
  UNSUPPORTED_LOCKFILE_VERSION: 'UNSUPPORTED_LOCKFILE_VERSION',
  UNSAFE_PATH: 'UNSAFE_PATH',
  UNSAFE_SYMLINK: 'UNSAFE_SYMLINK',
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_LINK_STATE: 'INVALID_LINK_STATE',
  IMPORT_CONFLICT: 'IMPORT_CONFLICT',
  SKILL_MISSING: 'SKILL_MISSING',
  SKILL_BROKEN: 'SKILL_BROKEN',
  RUNTIME_SKILL_NOT_FOUND: 'RUNTIME_SKILL_NOT_FOUND',
  AGENT_LINK_CONFLICT: 'AGENT_LINK_CONFLICT',
} as const

export type SkillboxErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface SkillboxErrorOptions {
  cause?: unknown
  context?: Record<string, unknown>
  recoverable?: boolean
}

export class SkillboxError extends Error {
  readonly code: SkillboxErrorCode
  readonly context: Record<string, unknown> | undefined
  readonly recoverable: boolean

  constructor(code: SkillboxErrorCode, message: string, options: SkillboxErrorOptions = {}) {
    const { cause, context, recoverable } = options
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SkillboxError'
    this.code = code
    this.context = context
    this.recoverable = recoverable ?? false
  }
}

export function isSkillboxError(error: unknown): error is SkillboxError {
  return error instanceof SkillboxError
}
