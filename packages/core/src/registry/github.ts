import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  RegistryError,
  RegistryErrorCode,
  isRegistryError,
  toRegistryError,
  isRegistryRecord,
  type RegistryErrorCodeName,
} from './errors.js'
import type {
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
} from './types.js'

/**
 * GitHub registry provider (MVP M14.3).
 *
 * Uses the public GitHub REST API via Node's global `fetch` — no new
 * dependencies and no OAuth: read-only, optional token. A token lifts the
 * unauthenticated rate limit from 60 requests/hour (a `403` with
 * `x-ratelimit-remaining: 0` or `429` maps to `REGISTRY_UNAVAILABLE`,
 * `reason: 'rate-limit'`).
 *
 * `download` materializes only the skill subtree (git trees + individual
 * blobs), never cloning the whole repository. `fetchImpl` is injectable so
 * tests drive the wire format without network access.
 *
 * Integrity: `resolve()` returns no integrity (contents are unknown before
 * download); after `download()`, callers compute it with
 * `computeSkillIntegrity(targetDir)` from `../integrity/`.
 */
export interface GitHubProviderOptions {
  /** Optional fine-grained/token for higher rate limits (never in URLs). */
  token?: string
  /** Injectable fetch (defaults to globalThis.fetch on Node >= 20). */
  fetchImpl?: typeof fetch
  /** GitHub REST API base URL (default `https://api.github.com`). */
  apiBaseUrl?: string
  /** Per-request timeout in ms (default 15s). */
  timeoutMs?: number
  /** Number of retries for transient failures (network, 5xx). */
  retries?: number
  /** Backoff base in ms between retry attempts. */
  retryBackoffMs?: number
}

interface GithubTreeEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
}

const DEFAULT_API_BASE_URL = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_RETRIES = 1
const DEFAULT_RETRY_BACKOFF_MS = 250
const SEARCH_PAGE_SIZE = 20

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Splits a `owner/repo` normalized repo expression; throws `SOURCE_INVALID`. */
function splitRepo(repo: string): { owner: string; repoName: string } {
  const index = repo.indexOf('/')
  if (index === -1 || index === 0 || index === repo.length - 1) {
    throw new RegistryError(
      RegistryErrorCode.SOURCE_INVALID,
      `GitHub source repo must be "owner/repo", got "${repo}"`,
      { reason: 'source', context: { repo } },
    )
  }
  return { owner: repo.slice(0, index), repoName: repo.slice(index + 1) }
}

/** Guards a tree-relative path against escaping `targetDir` (defense in depth). */
function assertSafeRelativePath(relativePath: string, repoPath: string): void {
  const segments = relativePath.split('/')
  for (const segment of segments) {
    if (segment === '..' || segment.length === 0 || segment.includes('\\')) {
      throw new RegistryError(
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
        `Unsafe path in repository tree: "${repoPath}"`,
        { reason: 'source', context: { repoPath } },
      )
    }
  }
}

function requireSha(json: unknown, kind: string): string {
  if (isRegistryRecord(json) && typeof json['sha'] === 'string' && json['sha'].length > 0) {
    return json['sha']
  }
  throw new RegistryError(
    RegistryErrorCode.REGISTRY_UNAVAILABLE,
    `GitHub response for ${kind} is missing "sha"`,
    { reason: 'http' },
  )
}

function headCommitSha(json: unknown): string {
  if (Array.isArray(json) && json.length > 0) {
    const first = json[0]
    if (isRegistryRecord(first) && typeof first['sha'] === 'string' && first['sha'].length > 0) {
      return first['sha']
    }
  }
  throw new RegistryError(
    RegistryErrorCode.REGISTRY_UNAVAILABLE,
    'GitHub commits response is missing the head commit sha',
    { reason: 'http' },
  )
}

export class GitHubProvider implements RegistryProvider {
  readonly id = 'github'

  private readonly token: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly apiBaseUrl: string
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly retryBackoffMs: number

  constructor(options: GitHubProviderOptions = {}) {
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = options.retries ?? DEFAULT_RETRIES
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
  }

  /**
   * Searches GitHub repositories (code search requires auth, so repository
   * search only). Popularity = stargazers; security state is always `unknown`
   * — GitHub does not vouch for skill content.
   */
  async search(query: string): Promise<RegistrySearchResult[]> {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return []
    }
    try {
      const json = await this.request('/search/repositories', {
        q: trimmed,
        per_page: String(SEARCH_PAGE_SIZE),
      })
      if (!isRegistryRecord(json) || !Array.isArray(json['items'])) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_SEARCH_FAILED,
          'GitHub search response is missing "items"',
          { reason: 'http' },
        )
      }
      const results: RegistrySearchResult[] = []
      for (const item of json['items']) {
        if (!isRegistryRecord(item)) {
          continue
        }
        const fullName = typeof item['full_name'] === 'string' ? item['full_name'] : undefined
        if (fullName === undefined) {
          continue
        }
        results.push({
          name: typeof item['name'] === 'string' ? item['name'] : fullName,
          source: `github:${fullName.toLowerCase()}`,
          popularity: typeof item['stargazers_count'] === 'number' ? item['stargazers_count'] : 0,
          security: 'unknown',
          description: typeof item['description'] === 'string' ? item['description'] : '',
        })
      }
      return results
    } catch (error) {
      throw this.rethrowAs(error, RegistryErrorCode.REGISTRY_SEARCH_FAILED, 'GitHub search failed')
    }
  }

  /** Pins a branch/tag/commit to a concrete commit SHA (MVP M14.3). */
  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    if (source.type !== 'github') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `GitHubProvider cannot resolve a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    const { owner, repoName } = splitRepo(source.repo)
    const ref = source.ref ?? source.branch
    try {
      const json =
        ref !== undefined
          ? await this.request(`/repos/${owner}/${repoName}/commits/${encodeURIComponent(ref)}`)
          : await this.request(`/repos/${owner}/${repoName}/commits`)
      const revision = ref !== undefined ? requireSha(json, `ref "${ref}"`) : headCommitSha(json)
      return { source, revision }
    } catch (error) {
      throw toRegistryError(error, 'GitHub resolve failed')
    }
  }

  /**
   * Materializes the skill subtree at `revision` into `targetDir` (existing
   * `targetDir` contents are left untouched; files are overlaid). Fetches the
   * recursive tree once, then each blob individually — no repository clone.
   */
  async download(source: NormalizedSource, revision: string, targetDir: string): Promise<void> {
    if (source.type !== 'github') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `GitHubProvider cannot download a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    const { owner, repoName } = splitRepo(source.repo)
    const prefix = source.path === undefined ? '' : source.path.replace(/^\/+|\/+$/g, '')

    let treeJson: unknown
    try {
      treeJson = await this.request(
        `/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(revision)}`,
        { recursive: '1' },
      )
    } catch (error) {
      throw this.rethrowAs(
        error,
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
        'GitHub download failed',
      )
    }

    if (isRegistryRecord(treeJson) && treeJson['truncated'] === true) {
      throw new RegistryError(
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
        `Repository tree for ${source.repo}@${revision} is too large to download`,
        { reason: 'http', context: { repo: source.repo, revision } },
      )
    }
    const entries: GithubTreeEntry[] = []
    if (isRegistryRecord(treeJson) && Array.isArray(treeJson['tree'])) {
      for (const item of treeJson['tree']) {
        if (
          isRegistryRecord(item) &&
          typeof item['path'] === 'string' &&
          typeof item['sha'] === 'string' &&
          item['type'] === 'blob'
        ) {
          entries.push({ path: item['path'], type: 'blob', sha: item['sha'] })
        }
      }
    }

    // Select the skill subtree: entries strictly under `prefix`, or a single
    // file when `prefix` itself is a blob (file-shaped skills).
    const blobEntries: Array<{ path: string; sha: string; relative: string }> = []
    let singleFile: { path: string; sha: string; relative: string } | undefined
    for (const entry of entries) {
      if (prefix.length === 0) {
        blobEntries.push({ path: entry.path, sha: entry.sha, relative: entry.path })
      } else if (entry.path === prefix) {
        singleFile = { path: entry.path, sha: entry.sha, relative: path.basename(prefix) }
      } else if (entry.path.startsWith(`${prefix}/`)) {
        blobEntries.push({
          path: entry.path,
          sha: entry.sha,
          relative: entry.path.slice(prefix.length + 1),
        })
      }
    }
    if (blobEntries.length === 0 && singleFile === undefined) {
      throw new RegistryError(
        RegistryErrorCode.REGISTRY_NOT_FOUND,
        `Skill path "${source.path ?? source.repo}" not found in ${source.repo}@${revision}`,
        { reason: 'not-found', context: { repo: source.repo, revision, path: source.path } },
      )
    }

    try {
      if (singleFile !== undefined) {
        assertSafeRelativePath(singleFile.relative, singleFile.path)
        const content = await this.fetchBlob(owner, repoName, singleFile.sha, singleFile.path)
        await this.writeFile(targetDir, singleFile.relative, content)
      }
      for (const entry of blobEntries) {
        assertSafeRelativePath(entry.relative, entry.path)
        const content = await this.fetchBlob(owner, repoName, entry.sha, entry.path)
        await this.writeFile(targetDir, entry.relative, content)
      }
    } catch (error) {
      if (isRegistryError(error)) {
        throw error
      }
      throw this.rethrowAs(
        error,
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
        'GitHub download failed',
      )
    }
  }

  /** Head commit SHA of the default branch (what `update` will compare against). */
  async getLatestRevision(source: NormalizedSource): Promise<string> {
    if (source.type !== 'github') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `GitHubProvider cannot resolve a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    const { owner, repoName } = splitRepo(source.repo)
    try {
      return headCommitSha(await this.request(`/repos/${owner}/${repoName}/commits`))
    } catch (error) {
      throw toRegistryError(error, 'GitHub getLatestRevision failed')
    }
  }

  // ------------------------------------------------------------------ //

  private async fetchBlob(
    owner: string,
    repoName: string,
    sha: string,
    entryPath: string,
  ): Promise<Buffer> {
    const json = await this.request(`/repos/${owner}/${repoName}/git/blobs/${sha}`)
    if (!isRegistryRecord(json) || typeof json['content'] !== 'string') {
      throw new RegistryError(
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
        `GitHub blob response for "${entryPath}" is missing content`,
        { reason: 'http', context: { path: entryPath } },
      )
    }
    const encoding = json['encoding']
    if (encoding === 'base64') {
      return Buffer.from(json['content'], 'base64')
    }
    if (encoding === 'utf-8') {
      return Buffer.from(json['content'], 'utf8')
    }
    throw new RegistryError(
      RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
      `GitHub blob response for "${entryPath}" has unsupported encoding "${String(encoding)}"`,
      { reason: 'http', context: { path: entryPath, encoding } },
    )
  }

  private async writeFile(targetDir: string, relativePath: string, content: Buffer): Promise<void> {
    const segments = relativePath.split('/')
    if (segments[segments.length - 1] === undefined || segments[segments.length - 1] === '') {
      throw new RegistryError(
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
        `Empty file name in repository tree: "${relativePath}"`,
        { reason: 'source', context: { relativePath } },
      )
    }
    const filePath = path.join(targetDir, ...segments)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content)
  }

  private async request(urlPath: string, query?: Record<string, string>): Promise<unknown> {
    const url = new URL(
      urlPath,
      this.apiBaseUrl.endsWith('/') ? this.apiBaseUrl : `${this.apiBaseUrl}/`,
    )
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value)
    }
    const maxAttempts = this.retries + 1
    let attempt = 0
    for (;;) {
      let response: Response
      try {
        response = await this.rawFetch(url)
      } catch (error) {
        if (attempt + 1 < maxAttempts && isRegistryError(error)) {
          const reason = error.reason
          if (reason === 'network' || reason === 'timeout') {
            attempt += 1
            await sleep(this.retryBackoffMs * attempt)
            continue
          }
        }
        throw error
      }
      const body = await readJson(response)
      if (response.status >= 200 && response.status < 300) {
        return body
      }
      const registryError = this.httpError(url, response, body)
      if (response.status >= 500 && attempt + 1 < maxAttempts && isRegistryError(registryError)) {
        attempt += 1
        await sleep(this.retryBackoffMs * attempt)
        continue
      }
      throw registryError
    }
  }

  private async rawFetch(url: URL): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'skillbox',
    }
    if (this.token !== undefined && this.token.length > 0) {
      headers['authorization'] = `Bearer ${this.token}`
    }
    try {
      return await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_UNAVAILABLE,
          `GitHub request timed out after ${this.timeoutMs}ms`,
          { reason: 'timeout', context: { url: url.toString() } },
        )
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new RegistryError(
        RegistryErrorCode.REGISTRY_UNAVAILABLE,
        `GitHub request failed: ${detail}`,
        { cause: error, reason: 'network', context: { url: url.toString() } },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private httpError(url: URL, response: Response, body: unknown): RegistryError {
    const status = response.status
    const context: Record<string, unknown> = { status, url: url.toString() }
    if (body !== null && body !== undefined) {
      context['body'] = body
    }
    const rateLimited =
      status === 429 || (status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    if (rateLimited) {
      return new RegistryError(
        RegistryErrorCode.REGISTRY_UNAVAILABLE,
        `GitHub API rate limit exceeded (HTTP ${status})`,
        { reason: 'rate-limit', context, recoverable: true },
      )
    }
    const message =
      isRegistryRecord(body) && typeof body['message'] === 'string' ? body['message'] : undefined
    if (status === 404) {
      return new RegistryError(
        RegistryErrorCode.REGISTRY_NOT_FOUND,
        message ?? `GitHub resource not found (HTTP 404): ${url.pathname}`,
        { reason: 'not-found', context },
      )
    }
    return new RegistryError(
      RegistryErrorCode.REGISTRY_UNAVAILABLE,
      message ?? `GitHub API request failed (HTTP ${status})`,
      { reason: 'http', context, recoverable: status >= 500 },
    )
  }

  /** Rewraps a failure under `code` while preserving reason/context/cause. */
  private rethrowAs(
    error: unknown,
    code: RegistryErrorCodeName,
    fallbackMessage: string,
  ): RegistryError {
    if (isRegistryError(error)) {
      return new RegistryError(code, error.message, {
        cause: error.cause,
        reason: error.reason,
        recoverable: error.recoverable,
        ...(error.context !== undefined ? { context: error.context } : {}),
      })
    }
    return toRegistryError(error, fallbackMessage, code)
  }
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
