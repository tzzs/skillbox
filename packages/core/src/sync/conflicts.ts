import { ErrorCode, SkillboxError } from '../errors.js'
import type { ConflictResolution, ConflictSession, SyncConflict } from './types.js'

const MAX_PREVIEW_LENGTH = 4_096

/**
 * Validates and returns a durable conflict session.  The session deliberately
 * contains only revisions and display-safe previews; credentials never cross
 * this boundary.
 */
export function parseConflictSession(value: unknown): ConflictSession {
  if (!isRecord(value) || value.version !== 1) {
    throw new SkillboxError(
      ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED,
      'This conflict session is no longer compatible. Start sync again.',
      { recoverable: true },
    )
  }

  const required = ['id', 'repositoryId', 'baseRevision', 'localRevision', 'remoteRevision', 'snapshotId', 'createdAt', 'expiresAt']
  if (required.some((key) => typeof value[key] !== 'string') || !Array.isArray(value.conflicts)) {
    throw new SkillboxError(
      ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED,
      'This conflict session is invalid. Start sync again.',
      { recoverable: true },
    )
  }

  const conflicts = value.conflicts.map(parseConflict)
  return {
    version: 1,
    id: value.id as string,
    repositoryId: value.repositoryId as string,
    baseRevision: value.baseRevision as string,
    localRevision: value.localRevision as string,
    remoteRevision: value.remoteRevision as string,
    snapshotId: value.snapshotId as string,
    createdAt: value.createdAt as string,
    expiresAt: value.expiresAt as string,
    conflicts,
  }
}

export function serializeConflictSession(session: ConflictSession): string {
  return JSON.stringify(parseConflictSession(session))
}

export function validateConflictSession(session: ConflictSession): void {
  parseConflictSession(session)
}

function parseConflict(value: unknown): SyncConflict {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string' || !Array.isArray(value.allowedResolutions) || typeof value.destructive !== 'boolean') {
    throw new SkillboxError(ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED, 'This conflict session is invalid. Start sync again.', { recoverable: true })
  }
  const allowedResolutions = value.allowedResolutions
  if (!allowedResolutions.every(isResolution) || (value.recommendedResolution !== undefined && !isResolution(value.recommendedResolution))) {
    throw new SkillboxError(ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED, 'This conflict session is invalid. Start sync again.', { recoverable: true })
  }
  for (const side of ['base', 'local', 'remote'] as const) {
    const candidate = value[side]
    if (isRecord(candidate) && typeof candidate.preview === 'string' && candidate.preview.length > MAX_PREVIEW_LENGTH) {
      throw new SkillboxError(ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED, 'This conflict session preview is too large. Start sync again.', { recoverable: true })
    }
  }
  return {
    id: value.id,
    type: value.type as SyncConflict['type'],
    ...(typeof value.skillAlias === 'string' ? { skillAlias: value.skillAlias } : {}),
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.field === 'string' ? { field: value.field } : {}),
    ...(isRecord(value.base) ? { base: value.base } : {}),
    ...(isRecord(value.local) ? { local: value.local } : {}),
    ...(isRecord(value.remote) ? { remote: value.remote } : {}),
    allowedResolutions: allowedResolutions as ConflictResolution[],
    ...(isResolution(value.recommendedResolution) ? { recommendedResolution: value.recommendedResolution } : {}),
    destructive: value.destructive,
  }
}

function isResolution(value: unknown): value is ConflictResolution {
  return value === 'local' || value === 'remote' || value === 'keep-both' || value === 'merged' || value === 'delete' || value === 'restore'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
