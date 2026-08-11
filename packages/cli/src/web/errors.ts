import { ErrorCode, isSkillboxError, SkillboxFsError, type SkillboxErrorCode } from '@skillbox/core'
import type { ApiErrorBody } from './types.js'

/**
 * M10.8 — every failing request is answered with the same envelope:
 * `{ "error": { "code", "message", "recoverable" } }`.
 */

/** HTTP status chosen for a known Skillbox error code. */
const STATUS_BY_CODE: Partial<Record<SkillboxErrorCode, number>> = {
  [ErrorCode.SKILL_NOT_FOUND]: 404,
  [ErrorCode.MANIFEST_NOT_FOUND]: 404,
  [ErrorCode.LOCKFILE_NOT_FOUND]: 404,
  [ErrorCode.AGENT_NOT_FOUND]: 404,
  [ErrorCode.RUNTIME_SKILL_NOT_FOUND]: 404,
  [ErrorCode.SKILL_MISSING]: 404,
  [ErrorCode.SKILL_BROKEN]: 409,
  [ErrorCode.AGENT_LINK_CONFLICT]: 409,
  [ErrorCode.IMPORT_CONFLICT]: 409,
  [ErrorCode.INTEGRITY_MISMATCH]: 409,
  [ErrorCode.INVALID_SKILL]: 400,
  [ErrorCode.INVALID_MANIFEST]: 400,
  [ErrorCode.UNSUPPORTED_MANIFEST_VERSION]: 400,
  [ErrorCode.INVALID_LOCKFILE]: 400,
  [ErrorCode.UNSUPPORTED_LOCKFILE_VERSION]: 400,
  [ErrorCode.INVALID_CONFIG]: 400,
  [ErrorCode.INVALID_LINK_STATE]: 400,
  [ErrorCode.UNSAFE_PATH]: 400,
  [ErrorCode.UNSAFE_SYMLINK]: 400,
  /* V0.3 registry layer (agent 1 contract) */
  [ErrorCode.REGISTRY_NOT_FOUND]: 404,
  [ErrorCode.REGISTRY_UNAVAILABLE]: 503,
  [ErrorCode.REGISTRY_SEARCH_FAILED]: 502,
  [ErrorCode.REGISTRY_DOWNLOAD_FAILED]: 502,
  [ErrorCode.SOURCE_UNSUPPORTED]: 400,
  [ErrorCode.SOURCE_INVALID]: 400,
  /* V0.3 install / updates layer (agent 2 contract) */
  [ErrorCode.CACHE_MISS]: 404,
  [ErrorCode.CACHE_INVALID]: 409,
  [ErrorCode.INSTALL_SOURCE_UNRESOLVED]: 502,
  [ErrorCode.INSTALL_DOWNLOAD_FAILED]: 502,
  [ErrorCode.INSTALL_INVALID_PATH]: 400,
  [ErrorCode.INSTALL_INVALID_STRUCTURE]: 400,
  [ErrorCode.INSTALL_SECURITY_BLOCKED]: 403,
  [ErrorCode.INSTALL_MATERIALIZE_FAILED]: 500,
  [ErrorCode.INSTALL_CONFLICT]: 409,
  [ErrorCode.INSTALL_AGENT_LINK_FAILED]: 409,
  [ErrorCode.INSTALL_ROLLBACK_FAILED]: 500,
  /* V0.4 diff layer (M19.5): the skill exists but has no diffable upstream /
     base snapshot in its current state. */
  [ErrorCode.DIFF_UPSTREAM_UNAVAILABLE]: 409,
  [ErrorCode.DIFF_BASE_UNAVAILABLE]: 409,
}

/** Issues a prudent person could resolve via Reconcile or a retry. */
const RECOVERABLE: ReadonlySet<string> = new Set<string>([
  ErrorCode.INTEGRITY_MISMATCH,
  ErrorCode.SKILL_MISSING,
  ErrorCode.SKILL_BROKEN,
  ErrorCode.AGENT_NOT_DETECTED,
  ErrorCode.AGENT_LINK_CONFLICT,
  ErrorCode.IMPORT_CONFLICT,
  ErrorCode.GIT_NOT_FOUND,
  /* V0.3 registry + install: transient upstream failures are retryable */
  ErrorCode.REGISTRY_UNAVAILABLE,
  ErrorCode.REGISTRY_SEARCH_FAILED,
  ErrorCode.REGISTRY_DOWNLOAD_FAILED,
  ErrorCode.INSTALL_SOURCE_UNRESOLVED,
  ErrorCode.INSTALL_DOWNLOAD_FAILED,
  /* Retrying with `allowPolicy: 'all'` after reviewing the findings is the
     documented recovery path for a security-blocked install. */
  ErrorCode.INSTALL_SECURITY_BLOCKED,
  /* Agent link failures are resolved by Reconcile (retryable). */
  ErrorCode.INSTALL_AGENT_LINK_FAILED,
])

export interface ApiErrorResult {
  status: number
  body: ApiErrorBody
}

/** A web-layer (non-Core) error with an explicit HTTP status and code. */
export class WebApiError extends Error {
  readonly code: string
  readonly status: number
  readonly recoverable: boolean

  constructor(code: string, message: string, status = 400, recoverable = false) {
    super(message)
    this.name = 'WebApiError'
    this.code = code
    this.status = status
    this.recoverable = recoverable
  }
}

function envelope(code: string, message: string, recoverable: boolean): ApiErrorBody {
  return { error: { code, message, recoverable } }
}

/** Default recoverable value for a known error code. */
function defaultRecoverable(code: unknown): boolean {
  return typeof code === 'string' && RECOVERABLE.has(code)
}

/** Converts any thrown value into the M10.8 JSON error envelope. */
export function toApiError(error: unknown): ApiErrorResult {
  if (error instanceof WebApiError) {
    return {
      status: error.status,
      body: envelope(error.code, error.message, error.recoverable),
    }
  }

  if (isSkillboxError(error)) {
    const status = STATUS_BY_CODE[error.code] ?? 500
    const recoverable = error.recoverable || defaultRecoverable(error.code)
    return {
      status,
      body: envelope(error.code, error.message, recoverable),
    }
  }

  if (error instanceof SkillboxFsError) {
    return {
      status: 500,
      body: envelope(
        'FILES_ERROR',
        `A filesystem operation failed, check the path permissions and retry. ${error.message}`,
        true,
      ),
    }
  }

  if (error instanceof Error) {
    return {
      status: 500,
      body: envelope('INTERNAL_ERROR', error.message, false),
    }
  }

  return {
    status: 500,
    body: envelope('INTERNAL_ERROR', String(error), false),
  }
}

/** JSON body for a request that does not match any API route (M10.8). */
export function unknownRouteEnvelope(): ApiErrorBody {
  return envelope('NOT_FOUND', 'The requested API endpoint does not exist.', false)
}
