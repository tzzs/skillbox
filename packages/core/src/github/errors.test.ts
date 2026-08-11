import { describe, expect, it } from 'vitest'
import { SkillboxError, ErrorCode, isSkillboxError } from '../errors.js'
import {
  GitHubError,
  GitHubErrorCode,
  isGitHubError,
  isRepositoryReuseError,
  requiresReauthorization,
  toGitHubError,
  isTransientGitHubError,
} from './errors.js'

describe('GitHubErrorCode', () => {
  it('keeps the codes unique', () => {
    const values = Object.values(GitHubErrorCode)
    expect(new Set(values).size).toBe(values.length)
  })

  it('exposes the five expected groups', () => {
    expect(GitHubErrorCode.GITHUB_API_ERROR).toBe('GITHUB_API_ERROR')
    expect(GitHubErrorCode.GITHUB_NETWORK_ERROR).toBe('GITHUB_NETWORK_ERROR')
    expect(GitHubErrorCode.GITHUB_TIMEOUT).toBe('GITHUB_TIMEOUT')
    expect(GitHubErrorCode.GITHUB_RATE_LIMITED).toBe('GITHUB_RATE_LIMITED')
    expect(GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED).toBe('GITHUB_REAUTHORIZATION_REQUIRED')
    expect(GitHubErrorCode.CREDENTIAL_STORE_UNAVAILABLE).toBe('CREDENTIAL_STORE_UNAVAILABLE')
  })
})

describe('GitHubError', () => {
  it('is a SkillboxError subtype so isSkillboxError() works', () => {
    const error = new GitHubError(GitHubErrorCode.GITHUB_API_ERROR, 'boom')
    expect(error).toBeInstanceOf(GitHubError)
    expect(error).toBeInstanceOf(SkillboxError)
    expect(isSkillboxError(error)).toBe(true)
    expect(isGitHubError(error)).toBe(true)
    expect(error.name).toBe('GitHubError')
  })

  it('defaults the reason to http', () => {
    const error = new GitHubError(GitHubErrorCode.GITHUB_API_ERROR, 'boom')
    expect(error.reason).toBe('http')
  })

  it('carries code, reason, context and recoverable', () => {
    const error = new GitHubError(GitHubErrorCode.GITHUB_RATE_LIMITED, 'slow down', {
      reason: 'rate-limit',
      recoverable: true,
      context: { status: 403 },
    })
    expect(error.code).toBe(GitHubErrorCode.GITHUB_RATE_LIMITED)
    expect(error.reason).toBe('rate-limit')
    expect(error.recoverable).toBe(true)
    expect(error.context).toEqual({ status: 403 })
  })

  it('also accepts shared Skillbox error codes', () => {
    const error = new GitHubError(ErrorCode.GIT_NOT_FOUND, 'git missing')
    expect(error.code).toBe(ErrorCode.GIT_NOT_FOUND)
  })
})

describe('toGitHubError', () => {
  it('passes through GitHubError instances', () => {
    const original = new GitHubError(GitHubErrorCode.GITHUB_TIMEOUT, 'timed out', {
      reason: 'timeout',
    })
    expect(toGitHubError(original)).toBe(original)
  })

  it('wraps a plain error with the fallback code', () => {
    const wrapped = toGitHubError(new Error('dns failure'))
    expect(wrapped).toBeInstanceOf(GitHubError)
    expect(wrapped.code).toBe(GitHubErrorCode.GITHUB_API_ERROR)
    expect(wrapped.message).toContain('dns failure')
    expect(wrapped.cause).toBeInstanceOf(Error)
  })

  it('converts SkillboxError preserving code and context', () => {
    const source = new SkillboxError(ErrorCode.INVALID_CONFIG, 'bad config', { context: { a: 1 } })
    const wrapped = toGitHubError(source)
    expect(wrapped).toBeInstanceOf(GitHubError)
    expect(wrapped.code).toBe(ErrorCode.INVALID_CONFIG)
    expect(wrapped.context).toEqual({ a: 1 })
  })
})

describe('isRepositoryReuseError', () => {
  const context = (status: number, body: unknown) =>
    new GitHubError(GitHubErrorCode.GITHUB_API_ERROR, 'x', { context: { status, body } })
  const message = (status: number, messageText: string) =>
    new GitHubError(GitHubErrorCode.GITHUB_API_ERROR, messageText, { context: { status } })

  it('accepts HTTP 409', () => {
    expect(isRepositoryReuseError(context(409, { message: 'conflict' }))).toBe(true)
  })

  it('accepts 422 with an already_exists error entry', () => {
    expect(
      isRepositoryReuseError(
        context(422, {
          message: 'Repository creation failed.',
          errors: [{ code: 'already_exists' }],
        }),
      ),
    ).toBe(true)
  })

  it('accepts 422 whose message mentions "already exists"', () => {
    expect(
      isRepositoryReuseError(context(422, { message: 'name already exists on this account' })),
    ).toBe(true)
    expect(isRepositoryReuseError(message(422, 'name already exists on this account'))).toBe(true)
  })

  it('rejects other 422 failures', () => {
    expect(isRepositoryReuseError(context(422, { message: 'name is invalid' }))).toBe(false)
  })

  it('rejects non-repository errors', () => {
    expect(
      isRepositoryReuseError(
        new GitHubError(GitHubErrorCode.GITHUB_NETWORK_ERROR, 'net', { reason: 'network' }),
      ),
    ).toBe(false)
    expect(isRepositoryReuseError(new Error('nope'))).toBe(false)
  })
})

describe('isTransientGitHubError / requiresReauthorization', () => {
  it('classifies network and timeout as transient', () => {
    expect(
      isTransientGitHubError(
        new GitHubError(GitHubErrorCode.GITHUB_NETWORK_ERROR, 'n', { reason: 'network' }),
      ),
    ).toBe(true)
    expect(
      isTransientGitHubError(
        new GitHubError(GitHubErrorCode.GITHUB_TIMEOUT, 't', { reason: 'timeout' }),
      ),
    ).toBe(true)
    expect(isTransientGitHubError(new GitHubError(GitHubErrorCode.GITHUB_API_ERROR, 'a'))).toBe(
      false,
    )
  })

  it('flags reauthorization requirements', () => {
    expect(
      requiresReauthorization(
        new GitHubError(GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED, 'r'),
      ),
    ).toBe(true)
    expect(
      requiresReauthorization(new GitHubError(GitHubErrorCode.GITHUB_REFRESH_FAILED, 'f')),
    ).toBe(false)
  })
})
