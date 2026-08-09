import { describe, expect, it, vi } from 'vitest'
import { MemoryCredentialStore } from './credential-store.js'
import { GitHubError, GitHubErrorCode } from './errors.js'
import { TokenStore, computeAuthorizationState } from './token-store.js'
import type { GitHubApi } from './api.js'
import type { TokenRecord } from './types.js'

const baseRecord: TokenRecord = {
  accessToken: 'ghu_access',
  tokenType: 'bearer',
  scope: 'repo',
  refreshToken: 'ghu_refresh',
  expiresAt: 1_000_000,
  refreshTokenExpiresAt: 2_000_000,
}

describe('computeAuthorizationState', () => {
  it('maps a missing record to not-connected', () => {
    expect(computeAuthorizationState(null, 999)).toBe('not-connected')
  })

  it('maps a non-expired access token to connected', () => {
    expect(computeAuthorizationState(baseRecord, 500_000)).toBe('connected')
  })

  it('treats a record without an expiry as connected', () => {
    const { expiresAt: _expiresAt, refreshTokenExpiresAt: _rt, ...noExpiry } = baseRecord
    expect(computeAuthorizationState(noExpiry, Date.now())).toBe('connected')
  })

  it('maps expired access + usable refresh token to refresh-required', () => {
    expect(computeAuthorizationState(baseRecord, 1_500_000)).toBe('refresh-required')
  })

  it('maps expired access + missing refresh token to reauthorization-required', () => {
    const { refreshToken: _refreshToken, refreshTokenExpiresAt: _rt, ...noRefresh } = baseRecord
    expect(computeAuthorizationState(noRefresh, 1_500_000)).toBe('reauthorization-required')
  })

  it('maps expired access + expired refresh token to reauthorization-required', () => {
    expect(computeAuthorizationState(baseRecord, 3_000_000)).toBe('reauthorization-required')
  })
})

describe('TokenStore', () => {
  function store(now = 500_000) {
    return new TokenStore({ store: new MemoryCredentialStore(), now: () => now })
  }

  it('reports not-connected and null when nothing is stored', async () => {
    const tokens = store()
    expect(await tokens.read()).toBeNull()
    expect(await tokens.state()).toBe('not-connected')
  })

  it('round-trips a record through the credential store as a JSON blob', async () => {
    const tokens = store()
    await tokens.save(baseRecord)
    expect(await tokens.read()).toEqual(baseRecord)
  })

  it('rejects corrupt or shapeless records as null', async () => {
    const memory = new MemoryCredentialStore()
    const tokens = new TokenStore({ store: memory })
    await memory.set({ service: 'skillbox-github', account: 'oauth-tokens' }, 'not-json{')
    expect(await tokens.read()).toBeNull()
    await memory.set({ service: 'skillbox-github', account: 'oauth-tokens' }, '{"foo":"bar"}')
    expect(await tokens.read()).toBeNull()
  })

  it('derives state from the stored record via the injected clock', async () => {
    const memory = new MemoryCredentialStore()
    const tokens = new TokenStore({ store: memory, now: () => 1_500_000 })
    await tokens.save(baseRecord)
    expect(await tokens.state()).toBe('refresh-required')
  })

  it('clear removes the record', async () => {
    const tokens = store()
    await tokens.save(baseRecord)
    await tokens.clear()
    expect(await tokens.read()).toBeNull()
  })

  it('refresh rotates and persists the new record', async () => {
    const tokens = store(1_500_000)
    await tokens.save(baseRecord)
    const fresh: TokenRecord = { ...baseRecord, accessToken: 'ghu_new', expiresAt: 9_000_000 }
    const api = { refreshAccessToken: vi.fn().mockResolvedValue(fresh) } as unknown as GitHubApi
    const result = await tokens.refresh(api)
    expect(result.status).toBe('refreshed')
    expect(await tokens.read()).toEqual(fresh)
  })

  it('refresh demands reauthorization when no record or refresh token exists', async () => {
    const tokens = store()
    expect(await tokens.refresh({} as unknown as GitHubApi)).toEqual({
      status: 'reauthorization-required',
    })
    await tokens.save({ accessToken: 'x', tokenType: 'bearer' })
    expect(await tokens.refresh({} as unknown as GitHubApi)).toEqual({
      status: 'reauthorization-required',
    })
  })

  it('refresh maps a rejected refresh token to reauthorization-required', async () => {
    const tokens = store()
    await tokens.save(baseRecord)
    const api = {
      refreshAccessToken: vi.fn().mockRejectedValue(
        new GitHubError(GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED, 'invalid_grant', {
          reason: 'oauth',
        }),
      ),
    } as unknown as GitHubApi
    expect(await tokens.refresh(api)).toEqual({ status: 'reauthorization-required' })
  })

  it('refresh rethrows non-reauthorization failures', async () => {
    const tokens = store()
    await tokens.save(baseRecord)
    const api = {
      refreshAccessToken: vi.fn().mockRejectedValue(
        new GitHubError(GitHubErrorCode.GITHUB_NETWORK_ERROR, 'network down', {
          reason: 'network',
        }),
      ),
    } as unknown as GitHubApi
    await expect(tokens.refresh(api)).rejects.toMatchObject({
      code: GitHubErrorCode.GITHUB_NETWORK_ERROR,
    })
  })
})
