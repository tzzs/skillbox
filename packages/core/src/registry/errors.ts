import { ErrorCode, SkillboxError, isSkillboxError } from '../errors.js'
import type { SkillboxErrorCode, SkillboxErrorOptions } from '../errors.js'

export { SkillboxError, ErrorCode, isSkillboxError }
export type { SkillboxErrorCode } from '../errors.js'

/**
 * Registry / source error codes. These mirror the shared `ErrorCode` entries
 * (appended with the `REGISTRY_` / `SOURCE_` prefixes) so cross-layer callers
 * (install transaction, cli search/add/update, web Explore) can match on `code`
 * without importing this module. `RegistryError` is a `SkillboxError` subtype.
 */
export const RegistryErrorCode = {
  /** A repo/skill/ref does not exist on the registry (HTTP 404). */
  REGISTRY_NOT_FOUND: 'REGISTRY_NOT_FOUND',
  /** The registry is unreachable or failed transiently (network/timeout/5xx/rate-limit). */
  REGISTRY_UNAVAILABLE: 'REGISTRY_UNAVAILABLE',
  /** The registry search endpoint or its response was unusable. */
  REGISTRY_SEARCH_FAILED: 'REGISTRY_SEARCH_FAILED',
  /** Materializing a skill subtree failed (blob fetch or local write error). */
  REGISTRY_DOWNLOAD_FAILED: 'REGISTRY_DOWNLOAD_FAILED',
  /** No provider handles this source type. */
  SOURCE_UNSUPPORTED: 'SOURCE_UNSUPPORTED',
  /** The user-facing source string could not be parsed. */
  SOURCE_INVALID: 'SOURCE_INVALID',
} as const

export type RegistryErrorCodeName = (typeof RegistryErrorCode)[keyof typeof RegistryErrorCode]

export type RegistryErrorReason =
  'network' | 'timeout' | 'rate-limit' | 'http' | 'not-found' | 'source'

export interface RegistryErrorOptions extends SkillboxErrorOptions {
  reason?: RegistryErrorReason
}

/** Typed error for every registry interaction. Extends `SkillboxError`. */
export class RegistryError extends SkillboxError {
  readonly reason: RegistryErrorReason

  constructor(code: RegistryErrorCodeName, message: string, options: RegistryErrorOptions = {}) {
    super(code as SkillboxErrorCode, message, options)
    this.name = 'RegistryError'
    this.reason = options.reason ?? 'http'
  }
}

export function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError
}

/** True for network/timeout-style failures that a retry loop may re-attempt. */
export function isTransientRegistryError(error: unknown): boolean {
  return isRegistryError(error) && (error.reason === 'network' || error.reason === 'timeout')
}

function registryCode(error: unknown): RegistryErrorCodeName | undefined {
  if (!isSkillboxError(error)) {
    return undefined
  }
  const code = error.code
  if (
    code === RegistryErrorCode.REGISTRY_NOT_FOUND ||
    code === RegistryErrorCode.REGISTRY_UNAVAILABLE ||
    code === RegistryErrorCode.REGISTRY_SEARCH_FAILED ||
    code === RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED ||
    code === RegistryErrorCode.SOURCE_UNSUPPORTED ||
    code === RegistryErrorCode.SOURCE_INVALID
  ) {
    return code
  }
  return undefined
}

/**
 * Maps a raw failure (HttpError-like, SkillboxError, or plain Error) onto a
 * `RegistryError`. Registry/Skillbox errors pass through unchanged; everything
 * else is wrapped with the fallback code.
 */
export function toRegistryError(
  error: unknown,
  fallbackMessage = 'Registry request failed',
  fallbackCode: RegistryErrorCodeName = RegistryErrorCode.REGISTRY_UNAVAILABLE,
): RegistryError {
  if (isRegistryError(error)) {
    return error
  }
  if (isSkillboxError(error)) {
    const code = registryCode(error)
    if (code !== undefined) {
      const options: RegistryErrorOptions = { cause: error.cause, recoverable: error.recoverable }
      if (error.context !== undefined) {
        options.context = error.context
      }
      return new RegistryError(code, error.message, options)
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new RegistryError(fallbackCode, `${fallbackMessage}: ${detail}`, {
    cause: error,
    reason: 'http',
  })
}

/** True when a failure means the registry has no such skill/repo/ref. */
export function isRegistryNotFound(error: unknown): boolean {
  return isRegistryError(error) && error.code === RegistryErrorCode.REGISTRY_NOT_FOUND
}

/** Narrowing guard for response bodies and untrusted JSON. */
export function isRegistryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
