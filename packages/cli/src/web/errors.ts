import {
  ErrorCode,
  isSkillboxError,
  scrubText,
  SkillboxFsError,
  type CleanupFailure,
  type CleanupStep,
  type RollbackReport,
  type SkillboxErrorCode,
} from '@skillbox/core'
import type { ApiErrorBody, SyncRollbackDto, SyncRollbackFailureDto } from './types.js'

/**
 * M10.8 — every failing request is answered with the same envelope:
 * `{ "error": { "code", "message", "recoverable" } }`, plus the optional
 * `rollback` report described on {@link ApiErrorBody}'s `error.rollback`.
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
  /* V0.4 lifecycle layer (M17/M18/M20): illegal transitions and merge-state
     conflicts are client-side mistakes, not infrastructure faults. */
  [ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION]: 409,
  [ErrorCode.LIFECYCLE_MANAGED_MODIFIED]: 409,
  [ErrorCode.MERGE_BINARY_CONFLICT]: 409,
  [ErrorCode.MERGE_ALREADY_IN_PROGRESS]: 409,
  [ErrorCode.MERGE_NOT_IN_PROGRESS]: 409,
  [ErrorCode.MERGE_NO_BASE]: 409,
  [ErrorCode.MERGE_INVALID_STATE]: 409,
  [ErrorCode.FORK_TARGET_EXISTS]: 409,
  [ErrorCode.VENDOR_TARGET_EXISTS]: 409,
  [ErrorCode.RESTORE_FAILED]: 500,
  [ErrorCode.RUNTIME_LOCKED]: 409,
  /* Fleet (multi-host SSH orchestration): bad config / selection is a client
     mistake; a missing local `ssh` binary is an infrastructure fault. */
  [ErrorCode.FLEET_CONFIG_NOT_FOUND]: 404,
  [ErrorCode.FLEET_CONFIG_INVALID]: 400,
  [ErrorCode.FLEET_HOST_NOT_FOUND]: 404,
  [ErrorCode.FLEET_HOST_EXISTS]: 409,
  [ErrorCode.FLEET_NO_HOSTS_SELECTED]: 400,
  [ErrorCode.FLEET_SSH_NOT_FOUND]: 503,
  /* Multi-device sync (RepositorySync): missing GitHub auth or a stale
     conflict session are client-side states to resolve, not server faults. */
  [ErrorCode.GITHUB_NOT_CONNECTED]: 400,
  [ErrorCode.GITHUB_UNAVAILABLE]: 503,
  [ErrorCode.GITHUB_AUTHORIZATION_DENIED]: 403,
  [ErrorCode.GITHUB_AUTHORIZATION_EXPIRED]: 400,
  [ErrorCode.GITHUB_AUTH_FAILED]: 401,
  [ErrorCode.GIT_REMOTE_CONFLICT]: 409,
  [ErrorCode.GIT_CONFLICT]: 409,
  [ErrorCode.GIT_DIRTY]: 409,
  [ErrorCode.GIT_PUSH_REJECTED]: 409,
  [ErrorCode.GIT_AUTH_FAILED]: 401,
  [ErrorCode.GIT_UNAVAILABLE]: 503,
  [ErrorCode.SYNC_CONFLICT_SESSION_NOT_FOUND]: 404,
  [ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED]: 410,
  [ErrorCode.SYNC_INVALID_CONFLICT_RESOLUTION]: 400,
  [ErrorCode.SYNC_VALIDATION_FAILED]: 409,
  [ErrorCode.SYNC_SNAPSHOT_NOT_FOUND]: 404,
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
  /* Fleet: installing ssh locally (or adding fleet.yaml/hosts) is a retry. */
  ErrorCode.FLEET_SSH_NOT_FOUND,
  /* Sync: transient GitHub/git unreachability, or reauthorizing after an
     expired device-flow session, are both plain retries. */
  ErrorCode.GITHUB_UNAVAILABLE,
  ErrorCode.GITHUB_AUTHORIZATION_EXPIRED,
  ErrorCode.GIT_UNAVAILABLE,
  /* An expired conflict session just needs a fresh `sync` to reopen it. */
  ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED,
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

function envelope(
  code: string,
  message: string,
  recoverable: boolean,
  rollback?: SyncRollbackDto,
): ApiErrorBody {
  return {
    error: {
      code,
      message,
      recoverable,
      /* Omitted, not `null`: an envelope without a rollback must be byte-for-byte
         what it was before this field existed. */
      ...(rollback === undefined ? {} : { rollback }),
    },
  }
}

/** Default recoverable value for a known error code. */
function defaultRecoverable(code: unknown): boolean {
  return typeof code === 'string' && RECOVERABLE.has(code)
}

/**
 * The *only* slice of `error.context` this API exports, read field by field.
 *
 * Contexts across Core hold whatever the failing layer had to hand — `git-client.ts`
 * puts a full command line (which can embed a transport credential), the repository
 * path and raw stdout/stderr into one — so serializing `context` as-is would put
 * secrets in a JSON response.  Logs never print context unfiltered either
 * (`logging/redact.ts` masks it first).  The sync transaction's rollback report is
 * the exception worth carving out (GAP §4.6): `restoreFailed` is the one fact a UI
 * has to act on, and today it only reaches the client as prose inside `message`.
 *
 * Every exported field is already in that `message`, so the whitelist reveals
 * nothing new; what it buys is structure *and* the guarantee that a context key
 * Core adds later cannot reach the browser without an explicit edit here.
 */
function rollbackOf(error: unknown): SyncRollbackDto | undefined {
  const context = (error as { context?: unknown }).context
  if (typeof context !== 'object' || context === null) return undefined
  const report = (context as { rollback?: unknown }).rollback
  if (!isRollbackReport(report)) return undefined
  return {
    snapshotId: report.snapshotId,
    restoreFailed: report.restoreFailed,
    // Only the array itself was checked, so each entry is re-validated from
    // `unknown`: an entry this layer cannot read is dropped rather than passed
    // through, so the response under-reports instead of shipping a shape the
    // client can't type.
    failures: (report.failures as unknown[]).flatMap((failure) =>
      isCleanupFailure(failure) ? [toRollbackFailureDto(failure)] : [],
    ),
  }
}

function toRollbackFailureDto(failure: CleanupFailure): SyncRollbackFailureDto {
  return {
    step: failure.step,
    // `target` is a restore-point id or a temporary sync-tree path, `message` the
    // deepest reason from the failure's `cause` chain — free text straight from
    // git/filesystem, so it goes through the same masking the log pipeline uses.
    target: scrubText(failure.target),
    message: scrubText(failure.message),
    blocking: failure.blocking,
  }
}

/** Structural check, not a cast: a hand-built or older `context.rollback` must not be trusted. */
function isRollbackReport(value: unknown): value is RollbackReport {
  if (typeof value !== 'object' || value === null) return false
  const report = value as Record<string, unknown>
  return (
    typeof report.snapshotId === 'string' &&
    typeof report.restoreFailed === 'boolean' &&
    Array.isArray(report.failures)
  )
}

/**
 * Cleanup steps this envelope is allowed to name.  Typed as Core's `CleanupStep`
 * so renaming a step there is a compile error on one of these literals; a step
 * *added* there is dropped here until it is listed, which keeps the response from
 * advertising a step no client can render.
 */
const REPORTED_STEPS: readonly CleanupStep[] = [
  'abort-merge',
  'restore',
  'remove-worktree',
  'remove-tree',
]

/**
 * Validates one cleanup entry.  Nothing here is cast from `unknown` to a domain
 * type without being checked first: an older or hand-built report must degrade to
 * a missing entry, never to a field the client types as a string but receives as
 * an object.
 */
function isCleanupFailure(value: unknown): value is CleanupFailure {
  if (typeof value !== 'object' || value === null) return false
  const failure = value as Record<string, unknown>
  return (
    typeof failure.step === 'string' &&
    (REPORTED_STEPS as readonly string[]).includes(failure.step) &&
    typeof failure.target === 'string' &&
    typeof failure.message === 'string' &&
    typeof failure.blocking === 'boolean'
  )
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
      body: envelope(error.code, error.message, recoverable, rollbackOf(error)),
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
    /* `reportCleanup` annotates the error it rethrows, and the sync transaction
       can fail on a plain fs/git Error, so this branch reads the report too. */
    return {
      status: 500,
      body: envelope('INTERNAL_ERROR', error.message, false, rollbackOf(error)),
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
