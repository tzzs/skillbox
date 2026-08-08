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
