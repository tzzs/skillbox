/**
 * Shared domain types for the GitHub integration (GAP_ANALYSIS §2.2,
 * SPEC §123-125, docs/superpowers/specs/2026-08-09-github-integration-design.md).
 */

/**
 * The five authorization states of the GitHub connection (SPEC §125.2):
 *
 * - `not-connected`: no device flow, no usable token.
 * - `authorizing`: device flow started, user has not authorized yet.
 * - `connected`: a valid (non-expired) access token is stored.
 * - `refresh-required`: access token expired but a refresh token can still
 *   rotate it silently.
 * - `reauthorization-required`: refresh token is gone/expired; the user must
 *   run the device flow again.
 */
export type AuthorizationState =
  'not-connected' | 'authorizing' | 'connected' | 'refresh-required' | 'reauthorization-required'

/**
 * OAuth token pair persisted into the OS Credential Store only. Timestamps
 * are epoch milliseconds. These values never enter config.json, manifests,
 * lockfiles, git remotes, argv, or logs.
 */
export interface TokenRecord {
  accessToken: string
  tokenType: string
  scope?: string
  refreshToken?: string
  /** Epoch ms after which the access token is no longer valid. */
  expiresAt?: number
  /** Epoch ms after which the refresh token can no longer rotate anything. */
  refreshTokenExpiresAt?: number
}

/** Response of `POST /login/device/code` (RFC 8628 §3.2). */
export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  /** Seconds before `deviceCode`/`userCode` expire (default 900). */
  expiresIn: number
  /** Minimum seconds between token polls (default 5). */
  interval: number
  /** Epoch ms when this device authorization was created. */
  createdAt: number
}

/** Result discriminated by the outcome of one token-poll round. */
export type DevicePollResult =
  | { status: 'authorized'; record: TokenRecord }
  | { status: 'pending' }
  | { status: 'slow-down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'failed'; message?: string }

/** The authenticated human/identity behind the token. */
export interface GitHubUser {
  id: number
  login: string
  name?: string
  htmlUrl: string
}

/** A GitHub repository (metadata only; never an auth-bearing URL). */
export interface GitHubRepository {
  id: number
  name: string
  owner: string
  fullName: string
  private: boolean
  defaultBranch: string
  htmlUrl: string
  /** Plain HTTPS clone URL; credentials are injected at transport time. */
  cloneUrl: string
}

export interface CreateRepositoryInput {
  name: string
  private: boolean
  description?: string
  /** Requested default branch. GitHub may fall back to the account default. */
  defaultBranch?: string
}

/** Default private repository name used by `skillbox` (MVP_TASKS §111E). */
export const DEFAULT_REPOSITORY_NAME = 'skillbox-skills'

/** Credential-store service id for the GitHub provider. */
export const GITHUB_PROVIDER_ID = 'github-app'

/** OAuth scopes requested during device flow. `repo` covers private content RW. */
export const DEFAULT_DEVICE_FLOW_SCOPE = 'repo'
