import { describe, expect, it } from 'vitest'
import { ErrorCode, SkillboxError, isSkillboxError } from './errors.js'

describe('ErrorCode', () => {
  it('maps every standard code to its string value', () => {
    const expected: Record<string, string> = {
      SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
      INVALID_SKILL: 'INVALID_SKILL',
      AGENT_NOT_DETECTED: 'AGENT_NOT_DETECTED',
      AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
      GIT_NOT_FOUND: 'GIT_NOT_FOUND',
      GIT_COMMAND_FAILED: 'GIT_COMMAND_FAILED',
      GIT_NOT_INITIALIZED: 'GIT_NOT_INITIALIZED',
      GIT_REMOTE_NOT_FOUND: 'GIT_REMOTE_NOT_FOUND',
      GIT_REMOTE_CONFLICT: 'GIT_REMOTE_CONFLICT',
      GIT_DETACHED_HEAD: 'GIT_DETACHED_HEAD',
      GIT_CONFLICT: 'GIT_CONFLICT',
      GIT_DIRTY: 'GIT_DIRTY',
      GIT_PUSH_REJECTED: 'GIT_PUSH_REJECTED',
      GIT_AUTH_FAILED: 'GIT_AUTH_FAILED',
      GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
      GITHUB_NOT_CONNECTED: 'GITHUB_NOT_CONNECTED',
      GITHUB_UNAVAILABLE: 'GITHUB_UNAVAILABLE',
      GITHUB_AUTHORIZATION_DENIED: 'GITHUB_AUTHORIZATION_DENIED',
      GITHUB_AUTHORIZATION_EXPIRED: 'GITHUB_AUTHORIZATION_EXPIRED',
      GITHUB_AUTH_FAILED: 'GITHUB_AUTH_FAILED',
      LOCKFILE_OUTDATED: 'LOCKFILE_OUTDATED',
      SECRET_FOUND: 'SECRET_FOUND',
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
      REGISTRY_NOT_FOUND: 'REGISTRY_NOT_FOUND',
      REGISTRY_UNAVAILABLE: 'REGISTRY_UNAVAILABLE',
      REGISTRY_SEARCH_FAILED: 'REGISTRY_SEARCH_FAILED',
      REGISTRY_DOWNLOAD_FAILED: 'REGISTRY_DOWNLOAD_FAILED',
      SOURCE_UNSUPPORTED: 'SOURCE_UNSUPPORTED',
      SOURCE_INVALID: 'SOURCE_INVALID',
      CACHE_MISS: 'CACHE_MISS',
      CACHE_INVALID: 'CACHE_INVALID',
      INSTALL_SOURCE_UNRESOLVED: 'INSTALL_SOURCE_UNRESOLVED',
      INSTALL_DOWNLOAD_FAILED: 'INSTALL_DOWNLOAD_FAILED',
      INSTALL_INVALID_PATH: 'INSTALL_INVALID_PATH',
      INSTALL_INVALID_STRUCTURE: 'INSTALL_INVALID_STRUCTURE',
      INSTALL_SECURITY_BLOCKED: 'INSTALL_SECURITY_BLOCKED',
      INSTALL_MATERIALIZE_FAILED: 'INSTALL_MATERIALIZE_FAILED',
      INSTALL_CONFLICT: 'INSTALL_CONFLICT',
      INSTALL_AGENT_LINK_FAILED: 'INSTALL_AGENT_LINK_FAILED',
      INSTALL_ROLLBACK_FAILED: 'INSTALL_ROLLBACK_FAILED',
      LIFECYCLE_ILLEGAL_TRANSITION: 'LIFECYCLE_ILLEGAL_TRANSITION',
      LIFECYCLE_MANAGED_MODIFIED: 'LIFECYCLE_MANAGED_MODIFIED',
      LIFECYCLE_COPY_FAILED: 'LIFECYCLE_COPY_FAILED',
      LIFECYCLE_BASE_SNAPSHOT_FAILED: 'LIFECYCLE_BASE_SNAPSHOT_FAILED',
      LIFECYCLE_ROLLBACK_FAILED: 'LIFECYCLE_ROLLBACK_FAILED',
      FORK_TARGET_EXISTS: 'FORK_TARGET_EXISTS',
      FORK_FAILED: 'FORK_FAILED',
      VENDOR_TARGET_EXISTS: 'VENDOR_TARGET_EXISTS',
      VENDOR_FAILED: 'VENDOR_FAILED',
      RESTORE_FAILED: 'RESTORE_FAILED',
      RUNTIME_LOCKED: 'RUNTIME_LOCKED',
      MIGRATION_MISSING: 'MIGRATION_MISSING',
      MIGRATION_FAILED: 'MIGRATION_FAILED',
      BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',
      BACKUP_INCOMPLETE: 'BACKUP_INCOMPLETE',
      BACKUP_REPOSITORY_MISMATCH: 'BACKUP_REPOSITORY_MISMATCH',
      ROLLBACK_FAILED: 'ROLLBACK_FAILED',
      DIFF_UPSTREAM_UNAVAILABLE: 'DIFF_UPSTREAM_UNAVAILABLE',
      DIFF_BASE_UNAVAILABLE: 'DIFF_BASE_UNAVAILABLE',
      MERGE_BINARY_CONFLICT: 'MERGE_BINARY_CONFLICT',
      MERGE_ALREADY_IN_PROGRESS: 'MERGE_ALREADY_IN_PROGRESS',
      MERGE_NOT_IN_PROGRESS: 'MERGE_NOT_IN_PROGRESS',
      MERGE_NO_BASE: 'MERGE_NO_BASE',
      MERGE_INVALID_STATE: 'MERGE_INVALID_STATE',
      FLEET_CONFIG_NOT_FOUND: 'FLEET_CONFIG_NOT_FOUND',
      FLEET_CONFIG_INVALID: 'FLEET_CONFIG_INVALID',
      FLEET_HOST_NOT_FOUND: 'FLEET_HOST_NOT_FOUND',
      FLEET_NO_HOSTS_SELECTED: 'FLEET_NO_HOSTS_SELECTED',
      FLEET_SSH_NOT_FOUND: 'FLEET_SSH_NOT_FOUND',
      FLEET_RUN_FAILED: 'FLEET_RUN_FAILED',
      OPERATION_BACKUP_NOT_FOUND: 'OPERATION_BACKUP_NOT_FOUND',
      OPERATION_ROLLBACK_REPOSITORY_MISMATCH: 'OPERATION_ROLLBACK_REPOSITORY_MISMATCH',
      OPERATION_ROLLBACK_EXPIRED: 'OPERATION_ROLLBACK_EXPIRED',
      OPERATION_ROLLBACK_INVALID: 'OPERATION_ROLLBACK_INVALID',
      OPERATION_JOURNAL_INVALID: 'OPERATION_JOURNAL_INVALID',
      OPERATION_RECOVERY_REQUIRED: 'OPERATION_RECOVERY_REQUIRED',
      OPERATION_SNAPSHOT_INVALID: 'OPERATION_SNAPSHOT_INVALID',
      SYNC_CONFLICT_SESSION_EXPIRED: 'SYNC_CONFLICT_SESSION_EXPIRED',
      SYNC_CONFLICT_SESSION_NOT_FOUND: 'SYNC_CONFLICT_SESSION_NOT_FOUND',
      SYNC_INVALID_CONFLICT_RESOLUTION: 'SYNC_INVALID_CONFLICT_RESOLUTION',
      SYNC_VALIDATION_FAILED: 'SYNC_VALIDATION_FAILED',
      SYNC_SNAPSHOT_NOT_FOUND: 'SYNC_SNAPSHOT_NOT_FOUND',
      SYNC_SNAPSHOT_RESTORE_FAILED: 'SYNC_SNAPSHOT_RESTORE_FAILED',
    }
    expect(ErrorCode).toEqual(expected)
  })

  it('keeps the constants unique', () => {
    const values = Object.values(ErrorCode)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('SkillboxError', () => {
  it('is an Error carrying code and message', () => {
    const err = new SkillboxError(ErrorCode.SKILL_NOT_FOUND, 'Skill not found')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SkillboxError')
    expect(err.code).toBe('SKILL_NOT_FOUND')
    expect(err.message).toBe('Skill not found')
  })

  it('defaults recoverable to false and context to undefined', () => {
    const err = new SkillboxError(ErrorCode.INVALID_SKILL, 'broken')
    expect(err.recoverable).toBe(false)
    expect(err.context).toBeUndefined()
  })

  it('propagates recoverable, context and cause', () => {
    const cause = new Error('root cause')
    const err = new SkillboxError(ErrorCode.INTEGRITY_MISMATCH, 'hash mismatch', {
      recoverable: true,
      context: { expected: 'abc', actual: 'def' },
      cause,
    })
    expect(err.recoverable).toBe(true)
    expect(err.context).toEqual({ expected: 'abc', actual: 'def' })
    expect(err.cause).toBe(cause)
  })

  it('throws through the typed error instead of raw strings', () => {
    let caught: unknown
    try {
      throw new SkillboxError(ErrorCode.UNSAFE_PATH, 'path escapes repository')
    } catch (error) {
      caught = error
    }
    expect(isSkillboxError(caught)).toBe(true)
    expect(caught).toMatchObject({
      code: ErrorCode.UNSAFE_PATH,
      message: 'path escapes repository',
    })
  })
})

describe('isSkillboxError', () => {
  it('accepts SkillboxError instances', () => {
    const err = new SkillboxError(ErrorCode.AGENT_NOT_DETECTED, 'no agent found')
    expect(isSkillboxError(err)).toBe(true)
  })

  it('rejects plain errors and non-errors', () => {
    const values: unknown[] = [
      new Error('plain'),
      'oops',
      42,
      null,
      undefined,
      { code: ErrorCode.GIT_NOT_FOUND },
    ]
    for (const value of values) {
      expect(isSkillboxError(value)).toBe(false)
    }
  })
})
