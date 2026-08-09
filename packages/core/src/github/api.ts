import { GitHubError, GitHubErrorCode, isRecord, isTransientGitHubError } from './errors.js'
import type {
  CreateRepositoryInput,
  DeviceAuthorization,
  GitHubRepository,
  GitHubUser,
  TokenRecord,
} from './types.js'

export const DEVICE_FLOW_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
export const REFRESH_TOKEN_GRANT_TYPE = 'refresh_token'
export const DEFAULT_POLL_INTERVAL = 5
export const DEFAULT_DEVICE_CODE_TTL = 900
export const GITHUB_API_VERSION = '2022-11-28'
export const DEFAULT_LIST_PER_PAGE = 100

export interface GitHubApiOptions {
  /** The public GitHub App / OAuth App client id shipped with the package. */
  clientId: string
  /** Base URL for the GitHub REST API. */
  apiBaseUrl?: string
  /** Base URL for OAuth/device-flow endpoints (github.com). */
  loginBaseUrl?: string
  /** Per-request timeout in ms. */
  timeoutMs?: number
  /** Number of retries for transient failures (network, 5xx, timeout). */
  retries?: number
  /** Backoff base in ms between retry attempts. */
  retryBackoffMs?: number
  /** Injectable fetch (defaults to globalThis.fetch on Node >= 20). */
  fetchImpl?: typeof fetch
  /** Time source in epoch ms (injected for deterministic tests). */
  now?: () => number
}

interface JsonResponse {
  status: number
  json: unknown
  headers: Headers
}

interface RequestInitLike {
  method: string
  headers: Record<string, string>
  signal: AbortSignal | null
  body?: string
}

export type OAuthPollResponse =
  | { status: 'authorized'; record: TokenRecord }
  | { status: 'pending' }
  | { status: 'slow-down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'failed'; message?: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requireString(json: Record<string, unknown>, field: string): string {
  const value = json[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubError(
      GitHubErrorCode.GITHUB_API_ERROR,
      `GitHub response is missing "${field}"`,
      {
        reason: 'http',
      },
    )
  }
  return value
}

function optionalString(json: Record<string, unknown>, field: string): string | undefined {
  const value = json[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Thin GitHub HTTP client.
 *
 * - Uses the Node >= 20 global `fetch` — no third-party HTTP dependency.
 * - Distinguishes timeout / rate-limit / network / auth / generic API errors
 *   and wraps every failure in `GitHubError` (a `SkillboxError` subtype).
 * - Never embeds tokens in URLs or error strings; tokens travel only through
 *   the `Authorization` header and the ephemeral OAuth form bodies.
 */
export class GitHubApi {
  readonly clientId: string
  readonly apiBaseUrl: string
  readonly loginBaseUrl: string
  readonly timeoutMs: number
  readonly retries: number
  readonly retryBackoffMs: number

  private readonly fetchImpl: typeof fetch
  private readonly nowFn: () => number

  constructor(options: GitHubApiOptions) {
    this.clientId = options.clientId
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com'
    this.loginBaseUrl = options.loginBaseUrl ?? 'https://github.com'
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.retries = options.retries ?? 1
    this.retryBackoffMs = options.retryBackoffMs ?? 250
    this.fetchImpl = options.fetchImpl ?? fetch
    this.nowFn = options.now ?? (() => Date.now())
  }

  /**
   * Step 1 of the device flow (RFC 8628 §3.1): request the device + user codes.
   * Returns the user-facing verification payload; the caller must display the
   * `userCode` and `verificationUri`.
   */
  async requestDeviceCode(scope: string = ''): Promise<DeviceAuthorization> {
    this.assertClientId()
    const body = formUrlEncode({ client_id: this.clientId, scope })
    const res = await this.fetchJson(`${this.loginBaseUrl}/login/device/code`, {
      method: 'POST',
      body,
      headers: jsonRequestHeaders(false),
      retries: 1,
    })
    const json = res.json
    if (!isRecord(json)) {
      throw this.unexpectedResponse('device/code', res)
    }
    const device: DeviceAuthorization = {
      deviceCode: requireString(json, 'device_code'),
      userCode: requireString(json, 'user_code'),
      verificationUri: requireString(json, 'verification_uri'),
      expiresIn:
        typeof json['expires_in'] === 'number' ? json['expires_in'] : DEFAULT_DEVICE_CODE_TTL,
      interval: typeof json['interval'] === 'number' ? json['interval'] : DEFAULT_POLL_INTERVAL,
      createdAt: this.now(),
    }
    const verificationUriComplete = optionalString(json, 'verification_uri_complete')
    if (verificationUriComplete !== undefined) {
      device.verificationUriComplete = verificationUriComplete
    }
    return device
  }

  /**
   * Step 3 of the device flow (RFC 8628 §3.4): one polling round against the
   * token endpoint. The error responses are transported on the wire as
   * `{ error, error_description }`; they are returned as outcomes instead of
   * being thrown so the caller can keep polling per the interval.
   */
  async pollAccessToken(deviceCode: string): Promise<OAuthPollResponse> {
    this.assertClientId()
    const body = formUrlEncode({
      client_id: this.clientId,
      device_code: deviceCode,
      grant_type: DEVICE_FLOW_GRANT_TYPE,
    })
    const res = await this.fetchJson(`${this.loginBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      body,
      headers: jsonRequestHeaders(false),
      retries: 1,
    })
    const json = isRecord(res.json) ? res.json : {}
    if (typeof json['access_token'] === 'string' && json['access_token'].length > 0) {
      return { status: 'authorized', record: this.tokenRecordFromOAuth(json) }
    }
    const error = optionalString(json, 'error')
    switch (error) {
      case 'authorization_pending':
        return { status: 'pending' }
      case 'slow_down':
        return {
          status: 'slow-down',
          interval: typeof json['interval'] === 'number' ? json['interval'] : DEFAULT_POLL_INTERVAL,
        }
      case 'expired_token':
        return { status: 'expired' }
      case 'access_denied':
        return { status: 'denied' }
      case undefined:
        throw this.unexpectedResponse('oauth poll', res)
      default:
        return {
          status: 'failed',
          message:
            optionalString(json, 'error_description') ?? `GitHub device flow error: ${error}`,
        }
    }
  }

  /**
   * Rotates an access token with the stored refresh token. Throws
   * `GITHUB_REAUTHORIZATION_REQUIRED` when the refresh token itself is
   * invalid or expired.
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenRecord> {
    this.assertClientId()
    const body = formUrlEncode({
      client_id: this.clientId,
      grant_type: REFRESH_TOKEN_GRANT_TYPE,
      refresh_token: refreshToken,
    })
    const res = await this.fetchJson(`${this.loginBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      body,
      headers: jsonRequestHeaders(false),
      retries: 0,
    })
    const json = isRecord(res.json) ? res.json : {}
    if (typeof json['access_token'] === 'string' && json['access_token'].length > 0) {
      return this.tokenRecordFromOAuth(json)
    }
    const error = optionalString(json, 'error')
    if (error === 'invalid_grant' || error === 'bad_verification_code') {
      throw new GitHubError(
        GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED,
        'GitHub refresh token is no longer valid; please reauthorize',
        { reason: 'auth', recoverable: true, context: { oauthError: error } },
      )
    }
    const detail = error !== undefined ? `: ${error}` : ''
    const options: ConstructorParameters<typeof GitHubError>[2] = {
      reason: 'oauth',
      recoverable: true,
    }
    if (error !== undefined) {
      options.context = { oauthError: error }
    }
    throw new GitHubError(
      GitHubErrorCode.GITHUB_REFRESH_FAILED,
      `Token refresh failed${detail}`,
      options,
    )
  }

  /** The authenticated user (used to verify the connected account, MVP 111B/111E). */
  async getCurrentUser(token: string): Promise<GitHubUser> {
    const res = await this.rest('GET', '/user', { token })
    const json = res.json
    if (!isRecord(json) || typeof json['id'] !== 'number' || typeof json['login'] !== 'string') {
      throw this.unexpectedResponse('GET /user', res)
    }
    const user: GitHubUser = {
      id: json['id'],
      login: json['login'],
      htmlUrl: optionalString(json, 'html_url') ?? `https://github.com/${json['login']}`,
    }
    const name = optionalString(json, 'name')
    if (name !== undefined) {
      user.name = name
    }
    return user
  }

  /** Lists repositories owned by the authenticated user (paginated page). */
  async listRepositories(
    token: string,
    options: { perPage?: number; page?: number } = {},
  ): Promise<GitHubRepository[]> {
    const query: Record<string, number> = {
      per_page: options.perPage ?? DEFAULT_LIST_PER_PAGE,
      page: options.page ?? 1,
    }
    const res = await this.rest('GET', '/user/repos', { token, query })
    const json = res.json
    if (!Array.isArray(json)) {
      throw this.unexpectedResponse('GET /user/repos', res)
    }
    const repositories: GitHubRepository[] = []
    for (const item of json) {
      if (isRecord(item)) {
        repositories.push(this.toRepository(item, res))
      }
    }
    return repositories
  }

  /** Fetches one repository by `owner/name`; returns `null` when absent. */
  async getRepository(
    token: string,
    owner: string,
    name: string,
  ): Promise<GitHubRepository | null> {
    try {
      const res = await this.rest('GET', `/repos/${owner}/${name}`, { token })
      return this.toRepository(this.requireObject(res), res)
    } catch (error) {
      if (
        error instanceof GitHubError &&
        typeof error.context?.['status'] === 'number' &&
        (error.context['status'] as number) === 404
      ) {
        return null
      }
      throw error
    }
  }

  /**
   * Creates a repository for the authenticated user. A name collision surfaces
   * as a `GitHubError` whose context carries the HTTP status; use
   * `isRepositoryReuseError()` to decide whether to reuse the existing repo.
   */
  async createRepository(token: string, input: CreateRepositoryInput): Promise<GitHubRepository> {
    const body: Record<string, unknown> = { name: input.name, private: input.private }
    if (input.description !== undefined) {
      body['description'] = input.description
    }
    if (input.defaultBranch !== undefined) {
      body['default_branch'] = input.defaultBranch
    }
    const res = await this.rest('POST', '/user/repos', { token, body })
    return this.toRepository(this.requireObject(res), res)
  }

  // --------------------------------------------------------------------- //

  private now(): number {
    return this.nowFn()
  }

  private assertClientId(): void {
    if (this.clientId.length === 0) {
      throw new GitHubError(
        GitHubErrorCode.GITHUB_DEVICE_FLOW_UNAVAILABLE,
        'GitHub client id is not configured; install the skillbox GitHub App',
        { reason: 'config', recoverable: true },
      )
    }
  }

  private tokenRecordFromOAuth(json: Record<string, unknown>): TokenRecord {
    const record: TokenRecord = {
      accessToken: requireString(json, 'access_token'),
      tokenType: optionalString(json, 'token_type') ?? 'bearer',
    }
    const scope = optionalString(json, 'scope')
    if (scope !== undefined) {
      record.scope = scope
    }
    const now = this.now()
    if (typeof json['expires_in'] === 'number' && json['expires_in'] > 0) {
      record.expiresAt = now + json['expires_in'] * 1000
    }
    const refreshToken = optionalString(json, 'refresh_token')
    if (refreshToken !== undefined) {
      record.refreshToken = refreshToken
    }
    if (
      typeof json['refresh_token_expires_in'] === 'number' &&
      json['refresh_token_expires_in'] > 0
    ) {
      record.refreshTokenExpiresAt = now + json['refresh_token_expires_in'] * 1000
    }
    return record
  }

  private toRepository(json: Record<string, unknown>, res: JsonResponse): GitHubRepository {
    if (
      typeof json['id'] !== 'number' ||
      typeof json['name'] !== 'string' ||
      typeof json['full_name'] !== 'string'
    ) {
      throw this.unexpectedResponse('repository', res)
    }
    const fullName = json['full_name']
    const owner = optionalString(isRecord(json['owner']) ? json['owner'] : {}, 'login') ?? ''
    const repository: GitHubRepository = {
      id: json['id'],
      name: json['name'],
      owner,
      fullName,
      private: json['private'] === true,
      defaultBranch:
        optionalString(json, 'default_branch') ??
        optionalString(isRecord(json['owner']) ? json['owner'] : {}, 'login') ??
        'main',
      htmlUrl: optionalString(json, 'html_url') ?? `https://github.com/${fullName}`,
      cloneUrl: optionalString(json, 'clone_url') ?? `https://github.com/${fullName}.git`,
    }
    return repository
  }

  private requireObject(res: JsonResponse): Record<string, unknown> {
    if (!isRecord(res.json)) {
      throw this.unexpectedResponse('body', res)
    }
    return res.json
  }

  private async rest(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    options: { token: string; query?: Record<string, number>; body?: Record<string, unknown> },
  ): Promise<JsonResponse> {
    const query = options.query
    let url = `${this.apiBaseUrl}${path}`
    if (query !== undefined) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        search.set(key, String(value))
      }
      url = `${url}?${search.toString()}`
    }
    const headers: Record<string, string> = jsonRequestHeaders(options.body !== undefined)
    headers['authorization'] = `Bearer ${options.token}`
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined
    const fetchOptions: {
      method: string
      headers: Record<string, string>
      body?: string
      retries?: number
    } = { method, headers }
    if (body !== undefined) {
      fetchOptions.body = body
    }
    return this.fetchJson(url, fetchOptions)
  }

  private async fetchJson(
    url: string,
    options: {
      method: string
      body?: string
      headers: Record<string, string>
      retries?: number
    },
  ): Promise<JsonResponse> {
    const maxAttempts = (options.retries ?? this.retries) + 1
    let attempt = 0
    for (;;) {
      let response: Response
      try {
        response = await this.rawFetch(url, options)
      } catch (error) {
        if (attempt + 1 < maxAttempts && this.isTransient(error)) {
          attempt += 1
          await sleep(this.retryBackoffMs * attempt)
          continue
        }
        throw error
      }
      const json = await readJson(response)
      const { status, headers } = response
      if (status >= 200 && status < 300) {
        return { status, json, headers }
      }
      if (status >= 500 && attempt + 1 < maxAttempts) {
        attempt += 1
        await sleep(this.retryBackoffMs * attempt)
        continue
      }
      throw this.httpError(url, options.method, response, json)
    }
  }

  private async rawFetch(
    url: string,
    options: { method: string; body?: string; headers: Record<string, string> },
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const init: RequestInitLike = {
      method: options.method,
      headers: options.headers,
      signal: controller.signal,
    }
    if (options.body !== undefined) {
      init.body = options.body
    }
    try {
      return await this.fetchImpl(url, init)
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new GitHubError(
          GitHubErrorCode.GITHUB_TIMEOUT,
          `GitHub request timed out after ${this.timeoutMs}ms`,
          { reason: 'timeout', context: { url } },
        )
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new GitHubError(
        GitHubErrorCode.GITHUB_NETWORK_ERROR,
        `GitHub request failed: ${detail}`,
        {
          cause: error,
          reason: 'network',
          context: { url },
        },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private isTransient(error: unknown): boolean {
    return isTransientGitHubError(error)
  }

  private httpError(url: string, method: string, response: Response, body: unknown): GitHubError {
    const status = response.status
    const context: Record<string, unknown> = { status, method, url }
    if (body !== null && body !== undefined) {
      context['body'] = body
    }
    const rateLimited =
      status === 429 || (status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    if (rateLimited) {
      return new GitHubError(
        GitHubErrorCode.GITHUB_RATE_LIMITED,
        `GitHub API rate limit exceeded (HTTP ${status})`,
        { reason: 'rate-limit', context, recoverable: true },
      )
    }
    const message =
      isRecord(body) && typeof body['message'] === 'string' ? body['message'] : undefined
    if (status === 401 || status === 403) {
      return new GitHubError(
        GitHubErrorCode.GITHUB_AUTH_FAILED,
        message ?? `GitHub authentication failed (HTTP ${status})`,
        { reason: 'auth', context, recoverable: true },
      )
    }
    return new GitHubError(
      GitHubErrorCode.GITHUB_API_ERROR,
      message ?? `GitHub API request failed (HTTP ${status})`,
      {
        reason: 'http',
        context,
        // 5xx is transient; the caller (or the retry loop) may try again.
        recoverable: status >= 500,
      },
    )
  }

  private unexpectedResponse(kind: string, res: JsonResponse): GitHubError {
    return new GitHubError(
      GitHubErrorCode.GITHUB_API_ERROR,
      `Unexpected GitHub ${kind} response (HTTP ${res.status})`,
      { reason: 'http', context: { status: res.status } },
    )
  }
}

function jsonRequestHeaders(jsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'skillbox',
  }
  if (jsonBody) {
    headers['content-type'] = 'application/json'
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded'
  }
  return headers
}

function formUrlEncode(record: Record<string, string>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(record)) {
    if (value.length > 0) {
      params.set(key, value)
    }
  }
  return params.toString()
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) {
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  )
}
