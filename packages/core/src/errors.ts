export const ErrorCode = {
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  INVALID_SKILL: 'INVALID_SKILL',
  AGENT_NOT_DETECTED: 'AGENT_NOT_DETECTED',
  GIT_NOT_FOUND: 'GIT_NOT_FOUND',
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  INVALID_LOCKFILE: 'INVALID_LOCKFILE',
  UNSAFE_PATH: 'UNSAFE_PATH',
  UNSAFE_SYMLINK: 'UNSAFE_SYMLINK',
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
