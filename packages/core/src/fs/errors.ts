import { SkillboxError, ErrorCode, isSkillboxError } from '../errors.js'

export { SkillboxError, ErrorCode, isSkillboxError }
export type { SkillboxErrorCode } from '../errors.js'

/**
 * Low-level fs-only codes. These are deliberately local: the domain error
 * model (M1) does not define IO/NOT_FOUND codes, so we keep them out of the
 * shared `ErrorCode` map until the layers are unified.
 */
export const FsIoErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  IO_ERROR: 'IO_ERROR',
} as const

export type FS_IoErrorCode = (typeof FsIoErrorCode)[keyof typeof FsIoErrorCode]
export type FsErrorCode =
  (typeof ErrorCode)[keyof typeof ErrorCode] | (typeof FsIoErrorCode)[keyof typeof FsIoErrorCode]

export interface SkillboxFsErrorOptions {
  path?: string
  cause?: unknown
}

export class SkillboxFsError extends Error {
  readonly code: FsErrorCode
  readonly path?: string

  constructor(code: FsErrorCode, message: string, options: SkillboxFsErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'SkillboxFsError'
    this.code = code
    if (options.path !== undefined) {
      this.path = options.path
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Wraps a raw fs error (or passes through an already typed Skillbox error) as
 * a typed error. ENOENT -> NOT_FOUND, EEXIST -> ALREADY_EXISTS, otherwise
 * IO_ERROR.
 */
export function toFsError(error: unknown, message: string, path?: string): SkillboxFsError {
  if (error instanceof SkillboxFsError) {
    if (path !== undefined && error.path === undefined) {
      return new SkillboxFsError(error.code, error.message, { cause: error.cause, path })
    }
    return error
  }
  const nodeCode = isNodeError(error) ? error.code : undefined
  let code: FS_IoErrorCode = FsIoErrorCode.IO_ERROR
  if (nodeCode === 'ENOENT') {
    code = FsIoErrorCode.NOT_FOUND
  } else if (nodeCode === 'EEXIST') {
    code = FsIoErrorCode.ALREADY_EXISTS
  }
  const options: SkillboxFsErrorOptions = { cause: error }
  if (path !== undefined) {
    options.path = path
  }
  return new SkillboxFsError(code, message, options)
}
