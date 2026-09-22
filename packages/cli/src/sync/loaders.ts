import * as path from 'node:path'
import {
  createCredentialStore,
  ErrorCode,
  GitHubApi,
  GitHubConfigStore,
  GitHubService,
  GitClient,
  RuntimeConfigService,
  scanFiles,
  SkillboxError,
  TokenStore,
  type CredentialStore,
  type GitCommitResult,
  type GitPullOptions,
  type GitPushOptions,
  type GitStatusResult,
  type RepositorySync,
  type ScanFilesOptions,
  type ScanResult,
} from '@skillbox/core'
import type {
  GitHubProvider,
  GitProvider,
  GitStatusReport,
  GitPullOutcome,
  GitCommitOutcome,
  GithubConnectionState,
  DeviceFlowStart,
  DeviceFlowPollResult,
  SecretScanResult,
  SecretScanner,
  SyncGitTransport,
} from './providers.js'

/**
 * Default providers for the sync pipeline. Each factory adapts the real core
 * implementation (`@skillbox/core`) onto the CLI contract, so the pipeline
 * logic never needs to know about git internals.
 *
 * The core imports are static and typed: a renamed or removed export is a
 * build failure here rather than a runtime "this build is missing an export"
 * guess. The `client` / `scan` parameters remain as seams for focused tests.
 */

/** Portable check for git's "not a repository" fatal from a failed status. */
function isNotARepositoryError(error: unknown): boolean {
  if (!(error instanceof SkillboxError) || error.code !== ErrorCode.GIT_COMMAND_FAILED) {
    return false
  }
  const stderr = error.context?.['stderr']
  return typeof stderr === 'string' && stderr.includes('not a git repository')
}

function gitUnavailable(hint: string): SkillboxError {
  return new SkillboxError(ErrorCode.GIT_UNAVAILABLE, hint)
}

/* ---------------------------------------------------------------------- *
 * Git — @skillbox/core/git
 *
 * `GitClient` takes options and receives `repositoryRoot` per call:
 *   status(root) -> { files, conflicts, staged, unstaged, untracked, clean }
 *   pull(root, opts?), push(root, opts?), commit(root, msg, files?)
 * ---------------------------------------------------------------------- */

/**
 * The slice of core `GitClient` this adapter uses. `GitClient` satisfies it
 * structurally, and a test double can implement just these methods.
 */
export interface CoreGitClient {
  status(repositoryRoot: string): Promise<GitStatusResult>
  pull(repositoryRoot: string, options?: GitPullOptions): Promise<void>
  push(repositoryRoot: string, options?: GitPushOptions): Promise<void>
  commit(
    repositoryRoot: string,
    message: string,
    files?: readonly string[],
  ): Promise<GitCommitResult>
  currentBranch?(repositoryRoot: string): Promise<string | undefined>
  isInstalled?(): Promise<boolean>
}

class GitClientAdapter implements GitProvider {
  constructor(
    private readonly repositoryRoot: string,
    private readonly client: CoreGitClient,
  ) {}

  private async assertInstalled(): Promise<void> {
    if ((await this.client.isInstalled?.()) === false) {
      throw gitUnavailable('The git binary is not installed or not on PATH.')
    }
  }

  async status(): Promise<GitStatusReport> {
    await this.assertInstalled()
    let result: GitStatusResult
    try {
      result = await this.client.status(this.repositoryRoot)
    } catch (error) {
      if (isNotARepositoryError(error)) {
        return {
          isRepository: false,
          ahead: 0,
          behind: 0,
          changedFiles: [],
          stagedFiles: [],
          conflicts: [],
        }
      }
      throw error
    }

    const branch = result.branch ?? (await this.client.currentBranch?.(this.repositoryRoot))
    const changed = result.files.filter((file) => !file.conflict)

    const report: GitStatusReport = {
      isRepository: true,
      ahead: result.ahead,
      behind: result.behind,
      changedFiles: changed.map((file) => file.path),
      stagedFiles: result.staged.map((file) => file.path),
      conflicts: result.conflicts.map((file) => file.path),
    }
    if (branch !== undefined) {
      report.branch = branch
    }
    if (result.remote !== undefined) {
      report.remote = result.remote
    }
    return report
  }

  async pull(): Promise<GitPullOutcome> {
    await this.assertInstalled()
    try {
      await this.client.pull(this.repositoryRoot)
    } catch (error) {
      if (isNotARepositoryError(error)) {
        throw gitUnavailable('No git repository to pull from.')
      }
      throw error
    }
    const status = await this.client.status(this.repositoryRoot)
    return {
      conflicts: status.conflicts.map((file) => file.path),
      changedFiles: status.files.map((file) => file.path),
    }
  }

  async commit(message: string, paths: readonly string[]): Promise<GitCommitOutcome> {
    await this.assertInstalled()
    try {
      const result = await this.client.commit(this.repositoryRoot, message, paths)
      return { committed: true, message, shortHash: result.hash.slice(0, 7) }
    } catch (error) {
      // git aborts with "nothing to commit" when none of the paths changed.
      const stderr = error instanceof Error ? ((error as { stderr?: string }).stderr ?? '') : ''
      if (
        error instanceof SkillboxError &&
        (error.message.includes('nothing to commit') || stderr.includes('nothing to commit'))
      ) {
        return { committed: false, message }
      }
      throw error
    }
  }

  async push(): Promise<void> {
    await this.assertInstalled()
    await this.client.push(this.repositoryRoot)
  }
}

export function createDefaultGitProvider(
  repositoryRoot: string,
  client: CoreGitClient = new GitClient(),
): GitProvider {
  return new GitClientAdapter(repositoryRoot, client)
}

/**
 * Adapts a Core {@link RepositorySync} (auth-aware pull/push) onto the CLI's
 * {@link SyncGitTransport} contract.
 *
 * `RepositorySync.pull()` throws when the pull ends in conflicts instead of
 * returning them, so the conflicts are read back from git status afterwards —
 * matching the `GitProvider.pull()` outcome shape the pipeline already renders
 * as a typed `GIT_CONFLICT` error.
 *
 * When the GitHub account is not connected (`GITHUB_NOT_CONNECTED`), the pull
 * falls back to the plain `gitProvider.pull()` — public remotes keep working
 * without a token; the credential bridge only kicks in when a token exists.
 */
export function createSyncGitTransport(
  repositorySync: Pick<RepositorySync, 'pull' | 'push'>,
  git: GitProvider,
): SyncGitTransport {
  return {
    async pull(): Promise<GitPullOutcome> {
      try {
        await repositorySync.pull()
      } catch (error) {
        // A divergent pull leaves the worktree in a conflict state; report it
        // through the same contract as GitProvider.pull so the pipeline keeps
        // its friendly conflict handling. Otherwise surface the original error.
        const status = await git.status()
        if (status.conflicts.length > 0) {
          return { conflicts: status.conflicts, changedFiles: status.changedFiles }
        }
        if (isNotConnectedError(error)) {
          const plain = await git.pull()
          return { conflicts: plain.conflicts, changedFiles: plain.changedFiles }
        }
        throw error
      }
      const status = await git.status()
      return { conflicts: status.conflicts, changedFiles: status.changedFiles }
    },
    async push(): Promise<void> {
      await repositorySync.push()
    },
  }
}

/** True when the error is the core "GitHub not connected" signal. */
function isNotConnectedError(error: unknown): boolean {
  return error instanceof SkillboxError && error.code === ErrorCode.GITHUB_NOT_CONNECTED
}

export const GITHUB_CLIENT_ID_ENV = 'SKILLBOX_GITHUB_CLIENT_ID'

export interface ProductionGitHubProviderOptions {
  /** Public GitHub App client id; defaults to SKILLBOX_GITHUB_CLIENT_ID. */
  clientId?: string
  /** Test/platform seam. Production defaults to the native credential store. */
  credentialStore?: CredentialStore
  /** GitHub API base (defaults to `SKILLBOX_GITHUB_API_BASE` / api.github.com). */
  apiBaseUrl?: string
  /** GitHub login base for the device flow (defaults to `SKILLBOX_GITHUB_LOGIN_BASE` / github.com). */
  loginBaseUrl?: string
}

/** Typed adapter over the shipped Core GitHubService. */
class CoreGitHubProviderAdapter implements GitHubProvider {
  constructor(private readonly service: GitHubService) {}

  async connectionState(): Promise<GithubConnectionState> {
    return (await this.service.getConnectionState()).state
  }

  async startDeviceFlow(): Promise<DeviceFlowStart> {
    const device = await this.service.startDeviceAuthorization()
    return {
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalMs: device.interval * 1_000,
      expiresInMs: device.expiresIn * 1_000,
    }
  }

  async pollDeviceFlow(): Promise<DeviceFlowPollResult> {
    const result = await this.service.pollDeviceAuthorization()
    if (result.status === 'slow-down') {
      return { status: 'slow-down', intervalMs: result.interval * 1_000 }
    }
    if (result.status === 'failed' && result.message !== undefined) {
      return { status: 'failed', message: result.message }
    }
    return { status: result.status }
  }

  async disconnect(): Promise<void> {
    await this.service.disconnect()
  }
}

/** Constructs the production GitHub graph with machine-local persistence. */
export function createProductionGitHubProvider(
  homeRoot: string,
  options: ProductionGitHubProviderOptions = {},
): GitHubProvider {
  const clientId = options.clientId ?? process.env[GITHUB_CLIENT_ID_ENV] ?? ''
  const api = new GitHubApi({
    clientId,
    ...(options.apiBaseUrl !== undefined
      ? { apiBaseUrl: options.apiBaseUrl }
      : process.env.SKILLBOX_GITHUB_API_BASE !== undefined
        ? { apiBaseUrl: process.env.SKILLBOX_GITHUB_API_BASE }
        : {}),
    ...(options.loginBaseUrl !== undefined
      ? { loginBaseUrl: options.loginBaseUrl }
      : process.env.SKILLBOX_GITHUB_LOGIN_BASE !== undefined
        ? { loginBaseUrl: process.env.SKILLBOX_GITHUB_LOGIN_BASE }
        : {}),
  })
  const credentialStore =
    options.credentialStore ??
    createCredentialStore({ secretsDir: path.join(homeRoot, 'state', 'secrets') })
  const tokenStore = new TokenStore({ store: credentialStore })
  const configStore = new GitHubConfigStore(
    new RuntimeConfigService({ configFilePath: path.join(homeRoot, 'config.json') }),
  )
  const service = new GitHubService({ clientId, api, tokenStore, configStore })
  return new CoreGitHubProviderAdapter(service)
}

export function createDefaultGitHubProvider(
  homeRoot: string,
  options: ProductionGitHubProviderOptions = {},
): GitHubProvider {
  return createProductionGitHubProvider(homeRoot, options)
}

/* ---------------------------------------------------------------------- *
 * Secret scanner — @skillbox/core/secret-scan
 *
 * Exported function `scanFiles(files, { root }) -> ScanResult`
 * with `{ findings, blocked, block }`. `block` blocks the pipeline.
 * ---------------------------------------------------------------------- */

export interface CoreSecretScan {
  (files: readonly string[], options?: ScanFilesOptions): Promise<ScanResult>
}

class SecretScannerAdapter implements SecretScanner {
  constructor(
    private readonly repositoryRoot: string,
    private readonly scan: CoreSecretScan,
  ) {}

  async isReady(): Promise<boolean> {
    return true
  }

  async scanChangedFiles(paths: readonly string[]): Promise<SecretScanResult> {
    const result = await this.scan(paths, { root: this.repositoryRoot })
    return {
      blocked: result.block,
      findings: result.findings.map((finding) => ({
        path: finding.file,
        rule: finding.patternId,
        severity: finding.severity,
        message: `[${finding.name}] ${finding.snippet}`,
      })),
    }
  }
}

export function createDefaultSecretScanner(
  repositoryRoot: string,
  scan: CoreSecretScan = scanFiles,
): SecretScanner {
  return new SecretScannerAdapter(repositoryRoot, scan)
}
