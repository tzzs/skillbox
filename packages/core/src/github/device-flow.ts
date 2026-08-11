import type { GitHubApi } from './api.js'
import { GitHubError, GitHubErrorCode } from './errors.js'
import type { TokenStore } from './token-store.js'
import type { AuthorizationState, DeviceAuthorization, DevicePollResult } from './types.js'

export interface DeviceFlowServiceOptions {
  api: GitHubApi
  tokenStore: TokenStore
  /** OAuth scope requested during the device flow (defaults to `repo`). */
  scope?: string
}

/**
 * Device Flow authorization state machine (SPEC §125.2, MVP_TASKS §111B).
 *
 * Implements the five authorization states:
 *
 * - `startAuthorization()` -> POST device/code, returns user_code +
 *   verification_uri and enters `authorizing`.
 * - `pollAuthorization()` -> one token-panel round. On success the token pair
 *   is persisted into the OS Credential Store and the state becomes
 *   `connected`. GitHub's `expired_token` maps to `refresh-required` (per the
 *   wave spec), `access_denied` returns to `not-connected`, and
 *   `authorization_pending`/`slow_down` keep the flow in `authorizing`.
 *
 * The device code is held in memory only and never persisted.
 */
export class DeviceFlowService {
  private readonly api: GitHubApi
  private readonly tokenStore: TokenStore
  private readonly scope: string

  private device: DeviceAuthorization | undefined
  private interval: number
  private currentState: AuthorizationState = 'not-connected'

  constructor(options: DeviceFlowServiceOptions) {
    this.api = options.api
    this.tokenStore = options.tokenStore
    this.scope = options.scope ?? 'repo'
    this.interval = 5
  }

  get state(): AuthorizationState {
    return this.currentState
  }

  get active(): boolean {
    return this.device !== undefined
  }

  get intervalSeconds(): number {
    return this.interval
  }

  /** Starts a new device flow; the returned payload must be shown to the user. */
  async startAuthorization(): Promise<DeviceAuthorization> {
    const device = await this.api.requestDeviceCode(this.scope)
    this.device = device
    this.interval = device.interval
    this.currentState = 'authorizing'
    return device
  }

  /**
   * Runs one polling round. Callers should honor `intervalSeconds` and re-poll
   * until the outcome is terminal (`authorized`, `expired`, `denied`,
   * `failed`).
   */
  async pollAuthorization(): Promise<DevicePollResult> {
    const device = this.device
    if (device === undefined) {
      throw new GitHubError(
        GitHubErrorCode.GITHUB_NOT_CONNECTED,
        'No active device authorization; call startAuthorization() first',
        { reason: 'auth', recoverable: true },
      )
    }
    const result = await this.api.pollAccessToken(device.deviceCode)
    switch (result.status) {
      case 'authorized':
        await this.tokenStore.save(result.record)
        this.device = undefined
        this.currentState = 'connected'
        return result
      case 'pending':
        this.currentState = 'authorizing'
        return result
      case 'slow-down':
        this.interval = result.interval
        this.currentState = 'authorizing'
        return result
      case 'expired':
        // The device code expired. Per the wave-2 task the machine transitions
        // to `refresh-required`; semantically the user must start over.
        this.device = undefined
        this.currentState = 'refresh-required'
        return result
      case 'denied':
        this.device = undefined
        this.currentState = 'not-connected'
        return result
      case 'failed':
        this.device = undefined
        this.currentState = 'not-connected'
        return result
    }
  }

  /** Cancels the active flow without touching any local repository state. */
  cancel(): void {
    this.device = undefined
    this.interval = 5
    this.currentState = 'not-connected'
  }
}
