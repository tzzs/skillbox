import {
  RegistryError,
  RegistryErrorCode,
  isRegistryError,
  toRegistryError,
  isRegistryRecord,
  type RegistryErrorCodeName,
} from './errors.js'
import { GitHubProvider } from './github.js'
import type {
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
  SecurityReviewState,
} from './types.js'

/**
 * skills.sh registry provider (MVP M14.4): search / resolve / metadata /
 * security-info for the skills.sh registry.
 *
 * The public skills.sh API contract is not documented precisely, so this
 * provider is built against an assumed JSON API shape and every assumption is
 * isolated behind this module:
 *
 * - `GET {baseUrl}/api/search?q=<query>` → `{ results: [...] }` where each
 *   result carries `name`, `description`, `popularity` (number) and
 *   `security` (`'reviewed' | 'unknown'`).
 * - `GET {baseUrl}/api/packages/<package>` → `{ package, name, description,
 *   repo?, path?, version?, security?, popularity }`. `repo`/`path` map the
 *   package onto a GitHub repository; when present, resolve/download delegate
 *   to {@link GitHubProvider}.
 *
 * When the real API differs, only this module needs to change.
 */
export interface SkillsShProviderOptions {
  /** Registry base URL (default `https://skills.sh`). */
  baseUrl?: string
  /** Injectable fetch (defaults to globalThis.fetch on Node >= 20). */
  fetchImpl?: typeof fetch
  /** Per-request timeout in ms (default 15s). */
  timeoutMs?: number
  /** Number of retries for transient failures. */
  retries?: number
  /** GitHub provider used for repo-backed packages (default: shared-config GitHubProvider). */
  githubProvider?: GitHubProvider
}

/** Metadata a skills.sh package resolves to (assumed API shape). */
export interface SkillsShPackageMetadata {
  /** Registry package expression, e.g. `vercel-labs/agent-skills`. */
  package: string
  name: string
  description: string
  /** Underlying GitHub `owner/repo` when the package maps to one. */
  repo?: string
  /** Repo-relative skill path when the registry reports one. */
  path?: string
  /** Version pin reported by the registry. */
  version?: string
  security: SecurityReviewState
  popularity: number
}

const DEFAULT_BASE_URL = 'https://skills.sh'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_RETRIES = 1

export class SkillsShProvider implements RegistryProvider {
  readonly id = 'skills-sh'

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly githubProvider: GitHubProvider

  constructor(options: SkillsShProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = options.retries ?? DEFAULT_RETRIES
    this.githubProvider =
      options.githubProvider ?? new GitHubProvider({ fetchImpl: this.fetchImpl })
  }

  /** Searches the registry (assumed `GET /api/search?q=`). */
  async search(query: string): Promise<RegistrySearchResult[]> {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return []
    }
    try {
      const json = await this.request('/api/search', { q: trimmed })
      if (!isRegistryRecord(json) || !Array.isArray(json['results'])) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_SEARCH_FAILED,
          'skills.sh search response is missing "results"',
          { reason: 'http' },
        )
      }
      const results: RegistrySearchResult[] = []
      for (const item of json['results']) {
        if (!isRegistryRecord(item)) {
          continue
        }
        const pkg = typeof item['package'] === 'string' ? item['package'] : undefined
        const name = typeof item['name'] === 'string' ? item['name'] : (pkg ?? '')
        if (name.length === 0) {
          continue
        }
        results.push({
          name,
          source: pkg !== undefined ? `skills.sh/${pkg}` : name,
          popularity: typeof item['popularity'] === 'number' ? item['popularity'] : 0,
          security: parseSecurity(item['security']),
          description: typeof item['description'] === 'string' ? item['description'] : '',
        })
      }
      return results
    } catch (error) {
      throw this.rethrowAs(
        error,
        RegistryErrorCode.REGISTRY_SEARCH_FAILED,
        'skills.sh search failed',
      )
    }
  }

  /**
   * Resolves a package to a pinned revision. Repo-backed packages delegate to
   * the GitHub provider (revision = commit SHA); registry-only packages fall
   * back to the reported version (or `latest`).
   */
  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    if (source.type !== 'skills-sh') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `SkillsShProvider cannot resolve a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    try {
      const metadata = await this.getPackageMetadata(source.package)
      if (metadata.repo !== undefined) {
        const githubSource: NormalizedSource = {
          type: 'github',
          repo: metadata.repo,
          ...(source.path !== undefined ? { path: source.path } : {}),
          ...(metadata.path !== undefined ? { path: metadata.path } : {}),
          ...(source.version !== undefined ? { ref: source.version } : {}),
          ...(metadata.version !== undefined ? { ref: metadata.version } : {}),
        }
        const resolved = await this.githubProvider.resolve(githubSource)
        return { source, revision: resolved.revision }
      }
      return {
        source,
        revision: source.version ?? metadata.version ?? 'latest',
      }
    } catch (error) {
      throw toRegistryError(error, 'skills.sh resolve failed')
    }
  }

  /** Downloads a package. Repo-backed packages delegate to GitHub; registry-only packages cannot be materialized by this API version. */
  async download(source: NormalizedSource, revision: string, targetDir: string): Promise<void> {
    if (source.type !== 'skills-sh') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `SkillsShProvider cannot download a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    try {
      const metadata = await this.getPackageMetadata(source.package)
      if (metadata.repo === undefined) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
          `skills.sh package "${source.package}" has no repository mapping in the registry API`,
          { reason: 'source', context: { package: source.package } },
        )
      }
      const githubSource: NormalizedSource = {
        type: 'github',
        repo: metadata.repo,
        ...(source.path !== undefined ? { path: source.path } : {}),
        ...(metadata.path !== undefined ? { path: metadata.path } : {}),
        ...(source.version !== undefined ? { ref: source.version } : {}),
        ...(metadata.version !== undefined ? { ref: metadata.version } : {}),
      }
      await this.githubProvider.download(githubSource, revision, targetDir)
    } catch (error) {
      if (isRegistryError(error)) {
        throw error
      }
      throw toRegistryError(error, 'skills.sh download failed')
    }
  }

  /** Latest revision: delegated to GitHub for repo-backed packages, else `latest`. */
  async getLatestRevision(source: NormalizedSource): Promise<string> {
    if (source.type !== 'skills-sh') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `SkillsShProvider cannot resolve a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    try {
      const metadata = await this.getPackageMetadata(source.package)
      if (metadata.repo !== undefined) {
        return this.githubProvider.getLatestRevision({
          type: 'github',
          repo: metadata.repo,
          ...(source.path !== undefined ? { path: source.path } : {}),
        })
      }
      return metadata.version ?? 'latest'
    } catch (error) {
      throw toRegistryError(error, 'skills.sh getLatestRevision failed')
    }
  }

  /** Metadata + security info for a package (assumed `GET /api/packages/<pkg>`). */
  async getPackageMetadata(pkg: string): Promise<SkillsShPackageMetadata> {
    try {
      const json = await this.request(`/api/packages/${encodeURIComponent(pkg)}`)
      if (!isRegistryRecord(json)) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_UNAVAILABLE,
          `skills.sh metadata response for "${pkg}" is not an object`,
          { reason: 'http' },
        )
      }
      const name = typeof json['name'] === 'string' && json['name'].length > 0 ? json['name'] : pkg
      const metadata: SkillsShPackageMetadata = {
        package: typeof json['package'] === 'string' ? json['package'] : pkg,
        name,
        description: typeof json['description'] === 'string' ? json['description'] : '',
        security: parseSecurity(json['security']),
        popularity: typeof json['popularity'] === 'number' ? json['popularity'] : 0,
      }
      if (typeof json['repo'] === 'string' && json['repo'].length > 0) {
        metadata.repo = json['repo']
      }
      if (typeof json['path'] === 'string' && json['path'].length > 0) {
        metadata.path = json['path']
      }
      if (typeof json['version'] === 'string' && json['version'].length > 0) {
        metadata.version = json['version']
      }
      return metadata
    } catch (error) {
      throw toRegistryError(error, 'skills.sh metadata request failed')
    }
  }

  /** Convenience: security review state for a package (`'reviewed' | 'unknown'`). */
  async getSecurityState(pkg: string): Promise<SecurityReviewState> {
    return (await this.getPackageMetadata(pkg)).security
  }

  // ------------------------------------------------------------------ //

  private async request(urlPath: string, query?: Record<string, string>): Promise<unknown> {
    const url = new URL(urlPath, `${this.baseUrl}/`)
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
            await sleep(this.retryBackoffMs(attempt))
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
      if (response.status >= 500 && attempt + 1 < maxAttempts) {
        attempt += 1
        await sleep(this.retryBackoffMs(attempt))
        continue
      }
      throw registryError
    }
  }

  private retryBackoffMs(attempt: number): number {
    return 250 * attempt
  }

  private async rawFetch(url: URL): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'skillbox' },
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_UNAVAILABLE,
          `skills.sh request timed out after ${this.timeoutMs}ms`,
          { reason: 'timeout', context: { url: url.toString() } },
        )
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new RegistryError(
        RegistryErrorCode.REGISTRY_UNAVAILABLE,
        `skills.sh request failed: ${detail}`,
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
    const message =
      isRegistryRecord(body) && typeof body['message'] === 'string' ? body['message'] : undefined
    if (status === 404) {
      return new RegistryError(
        RegistryErrorCode.REGISTRY_NOT_FOUND,
        message ?? `skills.sh resource not found (HTTP 404): ${url.pathname}`,
        { reason: 'not-found', context },
      )
    }
    return new RegistryError(
      RegistryErrorCode.REGISTRY_UNAVAILABLE,
      message ?? `skills.sh request failed (HTTP ${status})`,
      { reason: 'http', context, recoverable: status >= 500 },
    )
  }

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

function parseSecurity(value: unknown): SecurityReviewState {
  return value === 'reviewed' ? 'reviewed' : 'unknown'
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
