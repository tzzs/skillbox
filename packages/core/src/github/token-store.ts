import type { GitHubApi } from './api.js'
import { GitHubErrorCode, isGitHubError, requiresReauthorization } from './errors.js'
import type { AuthorizationState, TokenRecord } from './types.js'
import { CredentialStore } from './credential-store.js'
import type { CredentialKey } from './credential-store.js'

/** Default service/account pair used for the GitHub token record. */
export const TOKEN_SERVICE = 'skillbox-github'
export const TOKEN_ACCOUNT = 'oauth-tokens'

export type RefreshResult =
  { status: 'refreshed'; record: TokenRecord } | { status: 'reauthorization-required' }

export interface TokenStoreOptions {
  store: CredentialStore
  service?: string
  now?: () => number
}

function toCredentialKey(service: string): CredentialKey {
  return { service, account: TOKEN_ACCOUNT }
}

/**
 * Computes the authorization state from a stored token record (SPEC §125.2).
 *
 * - No record -> `not-connected`
 * - Access token valid -> `connected`
 * - Access token expired but a refresh token is still usable -> `refresh-required`
 * - Access token expired and no usable refresh token -> `reauthorization-required`
 */
export function computeAuthorizationState(
  record: TokenRecord | null,
  now: number,
): AuthorizationState {
  if (record === null) {
    return 'not-connected'
  }
  const accessExpired = record.expiresAt !== undefined && record.expiresAt <= now
  if (!accessExpired) {
    return 'connected'
  }
  const refreshTokenUsable =
    record.refreshToken !== undefined &&
    (record.refreshTokenExpiresAt === undefined || record.refreshTokenExpiresAt > now)
  return refreshTokenUsable ? 'refresh-required' : 'reauthorization-required'
}

/**
 * Token lifecycle for the GitHub provider (MVP_TASKS §111C/§111D, SPEC
 * §125.1). Access token, refresh token and expiry live exclusively in the OS
 * Credential Store as a single JSON blob so rotation is written atomically.
 * Tokens never enter config.json, manifests, lockfiles, remotes, logs, argv
 * or debug bundles.
 */
export class TokenStore {
  private readonly store: CredentialStore
  private readonly service: string
  private readonly now: () => number

  constructor(options: TokenStoreOptions) {
    this.store = options.store
    this.service = options.service ?? TOKEN_SERVICE
    this.now = options.now ?? (() => Date.now())
  }

  /** Current authorization state derived from the stored record. */
  async state(): Promise<AuthorizationState> {
    return computeAuthorizationState(await this.read(), this.now())
  }

  /** Reads and decodes the stored token record, or `null` when absent. */
  async read(): Promise<TokenRecord | null> {
    let serialized: string | null
    try {
      serialized = await this.store.get(toCredentialKey(this.service))
    } catch (error) {
      if (
        isGitHubError(error) &&
        // GitHubError's `code` is typed as the SkillboxErrorCode union, which
        // does not include the GitHub-specific store code; compare as strings.
        (error as { code: string }).code === GitHubErrorCode.CREDENTIAL_STORE_UNAVAILABLE
      ) {
        // No working credential store (headless Linux / WSL without a Secret
        // Service) means there cannot be a stored token: report
        // `not-connected` so callers fall back to the "run skillbox connect"
        // path instead of failing with a store error — public remotes keep
        // working through the plain git transport.
        return null
      }
      throw error
    }
    if (serialized === null) {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(serialized)
      if (!isRecord(parsed) || typeof parsed['accessToken'] !== 'string') {
        return null
      }
      return parsed as unknown as TokenRecord
    } catch {
      return null
    }
  }

  /** Stores a token record. One write => atomic from the store's perspective. */
  async save(record: TokenRecord): Promise<void> {
    await this.store.set(toCredentialKey(this.service), JSON.stringify(record))
  }

  /** Deletes the stored token record (used by disconnect). */
  async clear(): Promise<void> {
    await this.store.delete(toCredentialKey(this.service))
  }

  /**
   * Rotates the access token. Returns `reauthorization-required` when the
   * refresh token is missing, expired or rejected by GitHub; never loops.
   */
  async refresh(api: GitHubApi): Promise<RefreshResult> {
    const record = await this.read()
    if (record === null || record.refreshToken === undefined) {
      return { status: 'reauthorization-required' }
    }
    try {
      const fresh = await api.refreshAccessToken(record.refreshToken)
      await this.save(fresh)
      return { status: 'refreshed', record: fresh }
    } catch (error) {
      if (requiresReauthorization(error)) {
        return { status: 'reauthorization-required' }
      }
      throw error
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
