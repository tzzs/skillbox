import { describe, expect, it, vi } from 'vitest'
import { GitHubApi, DEVICE_FLOW_GRANT_TYPE } from './api.js'
import {
  GitHubErrorCode,
  isGitHubError,
  isRepositoryReuseError,
  requiresReauthorization,
} from './errors.js'

function fetchMock(
  impl: (url: string | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers(headers) })
}

function api(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof GitHubApi>[0]> = {},
) {
  return new GitHubApi({
    clientId: 'test-client-id',
    fetchImpl,
    retryBackoffMs: 0,
    retries: 0,
    ...overrides,
  })
}

const devicePayload = {
  device_code: 'device-123',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  verification_uri_complete: 'https://github.com/login/device?user_code=WDJB-MJHT',
  expires_in: 900,
  interval: 5,
}

const tokenPayload = {
  access_token: 'ghu_access-token',
  token_type: 'bearer',
  scope: 'repo',
  refresh_token: 'ghu_refresh-token',
  expires_in: 3600,
  refresh_token_expires_in: 15552000,
}

const repoPayload = {
  id: 1,
  name: 'skillbox-skills',
  full_name: 'octocat/skillbox-skills',
  owner: { login: 'octocat' },
  private: true,
  default_branch: 'main',
  html_url: 'https://github.com/octocat/skillbox-skills',
  clone_url: 'https://github.com/octocat/skillbox-skills.git',
}

describe('requestDeviceCode', () => {
  it('POSTs device/code and returns the user-facing payload', async () => {
    const fetchImpl = fetchMock(async (url, init) => {
      expect(String(url)).toBe('https://github.com/login/device/code')
      expect(init?.method).toBe('POST')
      expect(init?.body).toContain('client_id=test-client-id')
      expect(init?.body).toContain('scope=repo')
      return jsonResponse(devicePayload)
    })
    const client = api(fetchImpl)
    const device = await client.requestDeviceCode('repo')
    expect(device).toMatchObject({
      deviceCode: 'device-123',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: 'https://github.com/login/device?user_code=WDJB-MJHT',
      expiresIn: 900,
      interval: 5,
      createdAt: expect.any(Number) as unknown as number,
    })
  })

  it('throws GITHUB_DEVICE_FLOW_UNAVAILABLE when clientId is empty', async () => {
    const client = new GitHubApi({
      clientId: '',
      fetchImpl: fetchMock(async () => jsonResponse({})),
    })
    await expect(client.requestDeviceCode('repo')).rejects.toMatchObject({
      code: GitHubErrorCode.GITHUB_DEVICE_FLOW_UNAVAILABLE,
    })
  })
})

describe('pollAccessToken', () => {
  it('returns authorized with a token record carrying expiry', async () => {
    const before = Date.now()
    const fetchImpl = fetchMock(async () => jsonResponse(tokenPayload))
    const client = api(fetchImpl)
    const result = await client.pollAccessToken('device-123')
    expect(result.status).toBe('authorized')
    if (result.status !== 'authorized') return
    expect(result.record.accessToken).toBe('ghu_access-token')
    expect(result.record.refreshToken).toBe('ghu_refresh-token')
    expect(result.record.scope).toBe('repo')
    expect(result.record.tokenType).toBe('bearer')
    expect(result.record.expiresAt).toBeGreaterThan(before)
    expect(result.record.refreshTokenExpiresAt).toBeGreaterThan(before)
  })

  it('keeps polling on authorization_pending', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ error: 'authorization_pending' }))
    const result = await api(fetchImpl).pollAccessToken('device-123')
    expect(result.status).toBe('pending')
  })

  it('returns slow_down with the server interval', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ error: 'slow_down', interval: 10 }))
    const result = await api(fetchImpl).pollAccessToken('device-123')
    expect(result).toEqual({ status: 'slow-down', interval: 10 })
  })

  it('maps expired_token, access_denied and other failures', async () => {
    const client = api(fetchMock(async () => jsonResponse({ error: 'expired_token' })))
    expect((await client.pollAccessToken('d')).status).toBe('expired')

    const denied = api(fetchMock(async () => jsonResponse({ error: 'access_denied' })))
    expect((await denied.pollAccessToken('d')).status).toBe('denied')

    const disabled = api(
      fetchMock(async () =>
        jsonResponse({ error: 'device_flow_disabled', error_description: 'nope' }),
      ),
    )
    const failed = await disabled.pollAccessToken('d')
    expect(failed.status).toBe('failed')
    if (failed.status === 'failed') expect(failed.message).toBe('nope')
  })
})

describe('refreshAccessToken', () => {
  it('rotates the tokens on success', async () => {
    const before = Date.now()
    const fetchImpl = fetchMock(async (_url, init) => {
      expect(init?.body).toContain('grant_type=refresh_token')
      expect(init?.body).toContain('refresh_token=ghu_refresh-token')
      return jsonResponse(tokenPayload)
    })
    const record = await api(fetchImpl).refreshAccessToken('ghu_refresh-token')
    expect(record.accessToken).toBe('ghu_access-token')
    expect(record.expiresAt).toBeGreaterThan(before)
  })

  it('treats invalid_grant as reauthorization-required', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ error: 'invalid_grant' }))
    await expect(api(fetchImpl).refreshAccessToken('bad')).rejects.toMatchObject({
      code: GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED,
    })
  })

  it('reports non-terminal refresh failures as GITHUB_REFRESH_FAILED', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ error: 'access_denied' }))
    const error = await api(fetchImpl)
      .refreshAccessToken('x')
      .catch((e: unknown) => e)
    expect(isGitHubError(error)).toBe(true)
    if (isGitHubError(error)) {
      expect(error.code).toBe(GitHubErrorCode.GITHUB_REFRESH_FAILED)
      expect(requiresReauthorization(error)).toBe(false)
    }
  })
})

describe('REST endpoints', () => {
  it('gets the current user and parses the profile', async () => {
    const fetchImpl = fetchMock(async (_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer ghu_access-token' })
      return jsonResponse({
        id: 1,
        login: 'octocat',
        name: 'The Octocat',
        html_url: 'https://github.com/octocat',
      })
    })
    const user = await api(fetchImpl).getCurrentUser('ghu_access-token')
    expect(user).toMatchObject({
      id: 1,
      login: 'octocat',
      name: 'The Octocat',
      htmlUrl: 'https://github.com/octocat',
    })
  })

  it('maps 401 responses to GITHUB_AUTH_FAILED', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ message: 'Bad credentials' }, 401))
    const error = await api(fetchImpl)
      .getCurrentUser('bad')
      .catch((e: unknown) => e)
    expect(isGitHubError(error)).toBe(true)
    if (isGitHubError(error)) {
      expect(error.code).toBe(GitHubErrorCode.GITHUB_AUTH_FAILED)
      expect(error.reason).toBe('auth')
    }
  })

  it('detects rate limiting from the x-ratelimit-remaining header', async () => {
    const fetchImpl = fetchMock(async () =>
      jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
    )
    const error = await api(fetchImpl)
      .getCurrentUser('t')
      .catch((e: unknown) => e)
    expect(isGitHubError(error)).toBe(true)
    if (isGitHubError(error)) {
      expect(error.code).toBe(GitHubErrorCode.GITHUB_RATE_LIMITED)
      expect(error.reason).toBe('rate-limit')
      expect(error.recoverable).toBe(true)
    }
  })

  it('lists repositories with pagination query', async () => {
    const fetchImpl = fetchMock(async (url) => {
      expect(String(url)).toContain('per_page=100')
      expect(String(url)).toContain('page=1')
      return jsonResponse([repoPayload])
    })
    const repos = await api(fetchImpl).listRepositories('t')
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({
      fullName: 'octocat/skillbox-skills',
      private: true,
      owner: 'octocat',
    })
  })

  it('returns null for a 404 repository lookup', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ message: 'Not Found' }, 404))
    const repo = await api(fetchImpl).getRepository('t', 'octocat', 'missing')
    expect(repo).toBeNull()
  })

  it('creates a private repository with name and default branch', async () => {
    const fetchImpl = fetchMock(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ name: 'skillbox-skills', private: true, default_branch: 'main' })
      return jsonResponse(repoPayload, 201)
    })
    const repo = await api(fetchImpl).createRepository('t', {
      name: 'skillbox-skills',
      private: true,
      defaultBranch: 'main',
    })
    expect(repo.fullName).toBe('octocat/skillbox-skills')
  })

  it('surfaces a duplicate-name 422 as a reusable conflict', async () => {
    const fetchImpl = fetchMock(async () =>
      jsonResponse(
        {
          message: 'Repository creation failed.',
          errors: [
            {
              resource: 'Repository',
              field: 'name',
              code: 'custom',
              message: 'name already exists on this account',
            },
          ],
        },
        422,
      ),
    )
    const error = await api(fetchImpl)
      .createRepository('t', { name: 'skillbox-skills', private: true })
      .catch((e: unknown) => e)
    expect(isGitHubError(error)).toBe(true)
    if (isGitHubError(error)) {
      expect(error.code).toBe(GitHubErrorCode.GITHUB_API_ERROR)
      expect(error.context).toMatchObject({ status: 422 })
      expect(isRepositoryReuseError(error)).toBe(true)
    }
  })
})

describe('transport failures', () => {
  it('wraps network failures as GITHUB_NETWORK_ERROR', async () => {
    const fetchImpl = fetchMock(async () => {
      throw new TypeError('fetch failed')
    })
    const error = await api(fetchImpl)
      .getCurrentUser('t')
      .catch((e: unknown) => e)
    expect(isGitHubError(error)).toBe(true)
    if (isGitHubError(error)) {
      expect(error.code).toBe(GitHubErrorCode.GITHUB_NETWORK_ERROR)
      expect(error.reason).toBe('network')
    }
  })

  it('wraps aborted requests as GITHUB_TIMEOUT', async () => {
    const fetchImpl = fetchMock(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    )
    const client = new GitHubApi({ clientId: 'c', fetchImpl, timeoutMs: 25, retries: 0 })
    const error = await client.getCurrentUser('t').catch((e: unknown) => e)
    expect(isGitHubError(error)).toBe(true)
    if (isGitHubError(error)) {
      expect(error.code).toBe(GitHubErrorCode.GITHUB_TIMEOUT)
      expect(error.reason).toBe('timeout')
    }
  })

  it('retries transient 5xx responses', async () => {
    let calls = 0
    const fetchImpl = fetchMock(async () => {
      calls += 1
      if (calls === 1) {
        return jsonResponse({ message: 'server error' }, 503)
      }
      return jsonResponse({ id: 1, login: 'octocat', html_url: 'https://github.com/octocat' })
    })
    const client = new GitHubApi({ clientId: 'c', fetchImpl, retries: 2, retryBackoffMs: 0 })
    const user = await client.getCurrentUser('t')
    expect(user.login).toBe('octocat')
    expect(calls).toBe(2)
  })

  it('gives up after retries on persistent 5xx', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ message: 'boom' }, 500))
    const client = new GitHubApi({ clientId: 'c', fetchImpl, retries: 1, retryBackoffMs: 0 })
    const error = await client.getCurrentUser('t').catch((e: unknown) => e)
    expect(isGitHubError(error)).toBe(true)
    if (isGitHubError(error)) {
      expect(error.code).toBe(GitHubErrorCode.GITHUB_API_ERROR)
      expect(error.recoverable).toBe(true)
    }
  })
})

describe('oauth transport', () => {
  it('uses the RFC 8628 device grant type on the token endpoint', async () => {
    const fetchImpl = fetchMock(async (_url, init) => {
      expect(init?.body).toContain(`grant_type=${encodeURIComponent(DEVICE_FLOW_GRANT_TYPE)}`)
      expect(init?.body).toContain('device_code=device-code')
      return jsonResponse({ error: 'authorization_pending' })
    })
    await api(fetchImpl).pollAccessToken('device-code')
  })
})
