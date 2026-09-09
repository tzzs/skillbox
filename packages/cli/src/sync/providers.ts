/**
 * V0.2 Git Sync — provider contracts (CLI layer).
 *
 * These interfaces describe the shape the CLI sync pipeline depends on. They
 * are the agreed call sites for the parallel core workstreams:
 *
 * - Git (`GitProvider`)        → @skillbox/core `git/`  (agent 1, GitClient)
 * - GitHub (`GitHubProvider`)  → @skillbox/core `github/` (agent 2, Device Flow)
 * - Secrets (`SecretScanner`)  → @skillbox/core `secret-scan/` (agent 4)
 *
 * The CLI never talks to `git` itself; the loaders in `./loaders.js` map the
 * (not-yet-finished) core modules onto these interfaces, keeping the pipeline
 * testable and the wiring points isolated.
 */

export type GithubConnectionState =
  'not-connected' | 'authorizing' | 'connected' | 'refresh-required' | 'reauthorization-required'

/** `git status` facts consumed by `status` and the sync pipeline. */
export interface GitStatusReport {
  /** True when the repository is a git working tree. */
  isRepository: boolean
  /** Current branch, when on one. */
  branch?: string
  /** Configured remote (e.g. `origin`). */
  remote?: { name: string; url: string }
  /** Commits this branch is ahead of the upstream. */
  ahead: number
  /** Commits this branch is behind the upstream. */
  behind: number
  /** Worktree paths that changed vs the index/HEAD (uncommitted). */
  changedFiles: string[]
  /** Paths staged in the index. */
  stagedFiles: string[]
  /** Paths currently in a merge-conflict state. */
  conflicts: string[]
}

export interface GitPullOutcome {
  /** Paths that could not be auto-merged. Empty when the pull is clean. */
  conflicts: string[]
  /** Paths touched by the pull (merged/updated). */
  changedFiles: string[]
}

export interface GitCommitOutcome {
  /** False when there was nothing to commit for the requested paths. */
  committed: boolean
  message: string
  shortHash?: string
}

/** Git transport operations used by sync/pull/push/status. */
export interface GitProvider {
  status(): Promise<GitStatusReport>
  pull(): Promise<GitPullOutcome>
  /** Stages only `paths` (repo-relative) and commits them. */
  commit(message: string, paths: readonly string[]): Promise<GitCommitOutcome>
  push(): Promise<void>
}

/**
 * Auth-aware git transport used by the sync pipeline's pull/push steps.
 *
 * Production wiring routes these through Core's `RepositorySyncService`, which
 * injects the Credential Bridge (`getGitTransportAuth()`) into every
 * fetch/pull/push — so a private `skillbox-skills` repository syncs without
 * relying on OS git credential helpers. The pull outcome carries conflicts so
 * the pipeline keeps its typed `GIT_CONFLICT` errors.
 */
export interface SyncGitTransport {
  pull(): Promise<GitPullOutcome>
  push(): Promise<void>
}

export interface DeviceFlowStart {
  userCode: string
  verificationUri: string
  /** Provider-advised polling interval in milliseconds. */
  intervalMs: number
  /** Device code validity window in milliseconds. */
  expiresInMs: number
}

/** Outcome of one Device Flow token poll; terminal failures remain explicit. */
export type DeviceFlowPollResult =
  | { status: 'authorized' }
  | { status: 'pending' }
  | { status: 'slow-down'; intervalMs: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'failed'; message?: string }

/** GitHub Device Flow + connection lifecycle (agent 2 contract). */
export interface GitHubProvider {
  connectionState(): Promise<GithubConnectionState>
  startDeviceFlow(): Promise<DeviceFlowStart>
  pollDeviceFlow(): Promise<DeviceFlowPollResult>
  disconnect(): Promise<void>
}

export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface SecretFinding {
  /** Repo-relative path the finding was reported on. */
  path: string
  /** Matching rule id. */
  rule: string
  severity: SecretSeverity
  message: string
}

export interface SecretScanResult {
  findings: SecretFinding[]
  /** Critical/High findings require blocking the pipeline. */
  blocked: boolean
}

/** Changed-file secret scanning (agent 4 contract). */
export interface SecretScanner {
  /** False when the scan engine is not wired yet (step is skipped). */
  isReady(): Promise<boolean>
  scanChangedFiles(paths: readonly string[]): Promise<SecretScanResult>
}
