import { GitHubApi } from './api.js'
import { GitHubConfigStore } from './config.js'
import type { GitHubConnectionMetadata } from './config.js'
import { DeviceFlowService } from './device-flow.js'
import { GitHubError, GitHubErrorCode, isRepositoryReuseError } from './errors.js'
import { TokenStore, computeAuthorizationState } from './token-store.js'
import { GITHUB_PROVIDER_ID, DEFAULT_REPOSITORY_NAME } from './types.js'
import type {
  AuthorizationState,
  DeviceAuthorization,
  DevicePollResult,
  GitHubRepository,
  GitHubUser,
  TokenRecord,
} from './types.js'

export interface GitHubServiceOptions {
  /** The public GitHub App client id. */
  clientId: string
  api: GitHubApi
  tokenStore: TokenStore
  configStore: GitHubConfigStore
  deviceFlow?: DeviceFlowService
  now?: () => number
}

export interface GitHubConnectionSnapshot {
  state: AuthorizationState
  connected: boolean
  login?: string
  provider?: string
  repository?: string
}

export interface EnsureRepositoryOptions {
  name?: string
  private?: boolean
  description?: string
  defaultBranch?: string
}

export interface EnsureRepositoryResult {
  repository: GitHubRepository
  reused: boolean
}

/**
 * Orchestrates everything GitHub-related inside `@skillbox/core`
 * (GAP_ANALYSIS §2.2, SPEC §125, ARCHITECTURE §15.2).
 *
 * - Connect via Device Flow (start/poll/cancel)
 * - Token-aware API access with silent refresh
 * - Repository create/select, idempotent and re-usable on collision
 * - Disconnect that only clears local credentials + connection metadata and
 *   never touches repository/remote/skills
 */
export class GitHubService {
  private readonly api: GitHubApi
  private readonly tokenStore: TokenStore
  private readonly configStore: GitHubConfigStore
  private readonly deviceFlow: DeviceFlowService
  private readonly now: () => number

  constructor(options: GitHubServiceOptions) {
    this.api = options.api
    this.tokenStore = options.tokenStore
    this.configStore = options.configStore
    this.deviceFlow =
      options.deviceFlow ??
      new DeviceFlowService({ api: options.api, tokenStore: options.tokenStore })
    this.now = options.now ?? (() => Date.now())
  }

  /** The five-state view of the GitHub connection (SPEC §125.2). */
  async getConnectionState(): Promise<GitHubConnectionSnapshot> {
    const meta = await this.configStore.read()
    const record = await this.tokenStore.read()
    let state = computeAuthorizationState(record, this.now())
    if (this.deviceFlow.active && state === 'not-connected') {
      state = 'authorizing'
    } else if (meta.connected && state === 'not-connected') {
      // Config claims a connection but no usable token is stored -> degraded.
      state = 'reauthorization-required'
    }
    const snapshot: GitHubConnectionSnapshot = {
      state,
      connected: meta.connected,
    }
    if (meta.login !== undefined) snapshot.login = meta.login
    if (meta.provider !== undefined) snapshot.provider = meta.provider
    if (meta.repository !== undefined) snapshot.repository = meta.repository
    return snapshot
  }

  /** Device flow step 1: display `userCode`/`verificationUri` to the user. */
  async startDeviceAuthorization(): Promise<DeviceAuthorization> {
    return this.deviceFlow.startAuthorization()
  }

  /**
   * Device flow step 2: one poll round. On `authorized` the account is
   * verified against the current-user API and the connection metadata is
   * persisted (SPEC §125.1).
   */
  async pollDeviceAuthorization(): Promise<DevicePollResult> {
    const result = await this.deviceFlow.pollAuthorization()
    if (result.status === 'authorized') {
      const user = await this.api.getCurrentUser(result.record.accessToken)
      const meta = await this.configStore.read()
      await this.configStore.writeConnected({
        login: user.login,
        provider: GITHUB_PROVIDER_ID,
        ...(meta.repository !== undefined ? { repository: meta.repository } : {}),
      })
    }
    return result
  }

  /** Cancels the active device flow without touching local files. */
  async cancelDeviceAuthorization(): Promise<void> {
    this.deviceFlow.cancel()
  }

  /** The authenticated user; refreshes the token silently when possible. */
  async getCurrentUser(): Promise<GitHubUser> {
    const record = await this.requireToken()
    return this.api.getCurrentUser(record.accessToken)
  }

  /** Repositories owned by the authenticated user (for selection). */
  async listRepositories(): Promise<GitHubRepository[]> {
    const record = await this.requireToken()
    return this.api.listRepositories(record.accessToken)
  }

  /**
   * Creates a private repository (default name `skillbox-skills`) or reuses
   * an existing one with the same name (idempotent; GAP_ANALYSIS §2.2,
   * MVP_TASKS §111E). On success the config is rebound to the result.
   */
  async ensureRepository(options: EnsureRepositoryOptions = {}): Promise<EnsureRepositoryResult> {
    const record = await this.requireToken()
    const meta = await this.configStore.read()
    const user = await this.api.getCurrentUser(record.accessToken)
    const login = meta.login ?? user.login
    const name = options.name ?? DEFAULT_REPOSITORY_NAME

    let repository: GitHubRepository
    let reused = false
    try {
      repository = await this.api.createRepository(record.accessToken, {
        name,
        private: options.private ?? true,
        defaultBranch: options.defaultBranch ?? 'main',
        ...(options.description !== undefined ? { description: options.description } : {}),
      })
    } catch (error) {
      if (isRepositoryReuseError(error)) {
        const existing = await this.api.getRepository(record.accessToken, login, name)
        if (existing === null) {
          // The collision vanished between the create and the lookup; surface
          // the original error so the caller can retry once.
          throw error
        }
        repository = existing
        reused = true
      } else {
        throw error
      }
    }

    await this.configStore.writeConnected({
      login,
      provider: GITHUB_PROVIDER_ID,
      repository: repository.fullName,
    })
    return { repository, reused }
  }

  /** Binds an already-existing repository (selection flow). */
  async selectRepository(repository: GitHubRepository): Promise<void> {
    const meta = await this.configStore.read()
    await this.configStore.writeConnected({
      login: meta.login ?? repository.owner,
      provider: GITHUB_PROVIDER_ID,
      repository: repository.fullName,
    })
  }

  /** Attempts a silent refresh; returns the resulting authorization state. */
  async refreshTokens(): Promise<AuthorizationState> {
    const result = await this.tokenStore.refresh(this.api)
    return result.status === 'refreshed' ? 'connected' : 'reauthorization-required'
  }

  /**
   * Disconnects GitHub (SPEC §125.5). Deletes the OS Credential Store tokens
   * and clears local connection metadata only — the local repository, the
   * remote, and the user's skills are untouched. Provider-side revocation is
   * best-effort; without a client secret GitHub does not expose a usable
   * revocation endpoint, so it is deliberately left out.
   */
  async disconnect(): Promise<void> {
    await this.tokenStore.clear()
    await this.configStore.clear()
    this.deviceFlow.cancel()
  }

  /**
   * Returns a valid token for an authenticated operation, refreshing the
   * access token first when the stored one has expired (MVP_TASKS §111D:
   * "Refresh occurs before an authenticated operation when required"). Never
   * loops: a failed refresh throws reauthorization instead of retrying.
   */
  private async requireToken(): Promise<TokenRecord> {
    const record = await this.tokenStore.read()
    if (record === null) {
      throw new GitHubError(
        GitHubErrorCode.GITHUB_NOT_CONNECTED,
        'GitHub is not connected. Run `skillbox github connect` first',
        { reason: 'auth', recoverable: true },
      )
    }
    const state = computeAuthorizationState(record, this.now())
    if (state === 'connected') {
      return record
    }
    if (state === 'refresh-required') {
      const result = await this.tokenStore.refresh(this.api)
      if (result.status === 'refreshed') {
        return result.record
      }
    }
    throw new GitHubError(
      GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED,
      'GitHub reauthorization is required',
      { reason: 'auth', recoverable: true },
    )
  }
}

export type { GitHubConnectionMetadata }
