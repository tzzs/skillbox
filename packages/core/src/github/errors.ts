import { ErrorCode, SkillboxError, isSkillboxError } from '../errors.js'
import type { SkillboxErrorCode, SkillboxErrorOptions } from '../errors.js'

export { SkillboxError, ErrorCode, isSkillboxError }
export type { SkillboxErrorCode } from '../errors.js'

/**
 * GitHub-specific error codes (GAP_ANALYSIS §2.2 / SPEC §125).
 *
 * Following the `fs` module precedent (`packages/core/src/fs/errors.ts`),
 * low-level layer codes live locally instead of polluting the shared
 * `ErrorCode` map until the layers are unified. `GitHubError` is still a
 * `SkillboxError` subtype, so `isSkillboxError()` keeps working for every
 * GitHub failure.
 */
export const GitHubErrorCode = {
  /** Generic GitHub HTTP/API failure (4xx/5xx that is not auth or rate-limit). */
  GITHUB_API_ERROR: 'GITHUB_API_ERROR',
  /** The transport layer itself failed (DNS, refused, aborted socket, ...). */
  GITHUB_NETWORK_ERROR: 'GITHUB_NETWORK_ERROR',
  /** A request exceeded the configured timeout. */
  GITHUB_TIMEOUT: 'GITHUB_TIMEOUT',
  /** GitHub API rate limit reached (403 x-ratelimit-remaining: 0, or 429). */
  GITHUB_RATE_LIMITED: 'GITHUB_RATE_LIMITED',
  /** Authentication problem: 401/403, permission denial, invalid credentials. */
  GITHUB_AUTH_FAILED: 'GITHUB_AUTH_FAILED',
  /** Access-token refresh failed for a non-terminal reason. */
  GITHUB_REFRESH_FAILED: 'GITHUB_REFRESH_FAILED',
  /** The stored refresh token is invalid/expired; the user must reauthorize. */
  GITHUB_REAUTHORIZATION_REQUIRED: 'GITHUB_REAUTHORIZATION_REQUIRED',
  /** No usable token; the user has not connected GitHub yet. */
  GITHUB_NOT_CONNECTED: 'GITHUB_NOT_CONNECTED',
  /** Device flow unavailable (e.g. missing client id). */
  GITHUB_DEVICE_FLOW_UNAVAILABLE: 'GITHUB_DEVICE_FLOW_UNAVAILABLE',
  /** The platform credential store is missing, locked, or rejected the call. */
  CREDENTIAL_STORE_UNAVAILABLE: 'CREDENTIAL_STORE_UNAVAILABLE',
} as const

export type GitHubErrorCodeName = (typeof GitHubErrorCode)[keyof typeof GitHubErrorCode]
export type GitHubErrorCode = GitHubErrorCodeName | SkillboxErrorCode

/** Human-facing classifier used to tell timeout / rate-limit / network apart. */
export type GitHubErrorReason =
  'timeout' | 'rate-limit' | 'network' | 'http' | 'oauth' | 'auth' | 'store' | 'config'

export interface GitHubErrorOptions extends SkillboxErrorOptions {
  reason?: GitHubErrorReason
}

/**
 * Typed error for every GitHub interaction. Extends `SkillboxError` and reuses
 * its `code`/`context`/`recoverable`/`cause` contract so callers can rely on
 * the standard `isSkillboxError` guard.
 */
export class GitHubError extends SkillboxError {
  readonly reason: GitHubErrorReason

  constructor(code: GitHubErrorCode, message: string, options: GitHubErrorOptions = {}) {
    super(code as SkillboxErrorCode, message, options)
    this.name = 'GitHubError'
    this.reason = options.reason ?? 'http'
  }
}

export function isGitHubError(error: unknown): error is GitHubError {
  return error instanceof GitHubError
}

/** True for network/timeout failures that a retry loop may safely re-attempt. */
export function isTransientGitHubError(error: unknown): boolean {
  if (!isGitHubError(error)) {
    return false
  }
  const code = error.code as GitHubErrorCode
  return code === GitHubErrorCode.GITHUB_NETWORK_ERROR || code === GitHubErrorCode.GITHUB_TIMEOUT
}

/** True when a failure means the user must run the device flow again. */
export function requiresReauthorization(error: unknown): boolean {
  return (
    isGitHubError(error) &&
    (error.code as GitHubErrorCode) === GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED
  )
}

/** Narrowing guard for response bodies and untrusted JSON. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalizes an unknown failure into a `GitHubError`, passing through errors
 * that are already typed as GitHub/Skillbox errors.
 */
export function toGitHubError(
  error: unknown,
  fallbackMessage = 'GitHub request failed',
  fallbackCode: GitHubErrorCode = GitHubErrorCode.GITHUB_API_ERROR,
): GitHubError {
  if (isGitHubError(error)) {
    return error
  }
  if (error instanceof SkillboxError) {
    const options: GitHubErrorOptions = { cause: error.cause, recoverable: error.recoverable }
    if (error.context !== undefined) {
      options.context = error.context
    }
    return new GitHubError(error.code, error.message, options)
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new GitHubError(fallbackCode, `${fallbackMessage}: ${detail}`, {
    cause: error,
    reason: 'http',
  })
}

/**
 * True when an error signals that creating a repository collided with an
 * existing one, i.e. the operation can be retried idempotently by reusing the
 * repository that is already there.
 *
 * GitHub reports duplicate names as `422` with an `errors` entry whose code is
 * `already_exists`/`custom` and message mentions "already exists"; `409` is
 * treated the same way defensively.
 */
export function isRepositoryReuseError(error: unknown): boolean {
  if (!isGitHubError(error)) {
    return false
  }
  const status = error.context?.['status']
  if (status === 409) {
    return true
  }
  if (status !== 422) {
    return false
  }
  if (error.message.toLowerCase().includes('already exists')) {
    return true
  }
  if (isRecord(error.context?.['body'])) {
    const body = error.context['body']
    if (
      typeof body['message'] === 'string' &&
      body['message'].toLowerCase().includes('already exists')
    ) {
      return true
    }
    const errors = body['errors']
    if (Array.isArray(errors)) {
      return errors.some((entry) => {
        if (!isRecord(entry)) {
          return false
        }
        if (entry['code'] === 'already_exists') {
          return true
        }
        return (
          typeof entry['message'] === 'string' &&
          entry['message'].toLowerCase().includes('already exists')
        )
      })
    }
  }
  return false
}
