import { describe, expect, it } from 'vitest'
import { ErrorCode, SkillboxError } from '../errors.js'
import { parseConflictSession, serializeConflictSession } from './conflicts.js'
import type { ConflictSession } from './types.js'

const session: ConflictSession = {
  version: 1,
  id: 'session-1',
  repositoryId: 'repository-1',
  baseRevision: 'base',
  localRevision: 'local',
  remoteRevision: 'remote',
  snapshotId: 'snapshot-1',
  createdAt: '2026-08-13T00:00:00.000Z',
  expiresAt: '2026-08-14T00:00:00.000Z',
  conflicts: [{ id: 'demo:enabled', type: 'manifest-field', skillAlias: 'demo', field: 'enabled', allowedResolutions: ['local', 'remote', 'merged'], destructive: false }],
}

describe('ConflictSession serialization', () => {
  it('round-trips a versioned display-safe session', () => {
    expect(parseConflictSession(JSON.parse(serializeConflictSession(session)))).toEqual(session)
  })

  it('rejects unknown versions as a recoverable session error', () => {
    expect(() => parseConflictSession({ ...session, version: 2 })).toThrowError(SkillboxError)
    try { parseConflictSession({ ...session, version: 2 }) } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.SYNC_CONFLICT_SESSION_EXPIRED, recoverable: true })
    }
  })

  it('does not synthesize or serialize credentials', () => {
    const serialized = serializeConflictSession({ ...session, token: 'secret' } as ConflictSession)
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('secret')
  })

  it('keeps resolutions and destructive flags explicit', () => {
    const conflict = session.conflicts[0]!
    expect(conflict.allowedResolutions).toContain('local')
    expect(conflict.destructive).toBe(false)
  })
})
