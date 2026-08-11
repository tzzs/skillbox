import * as path from 'node:path'
import {
  createCredentialStore,
  ErrorCode,
  GitHubApi,
  GitHubConfigStore,
  GitHubService,
  RuntimeConfigService,
  SkillboxError,
  TokenStore,
  type CredentialStore,
} from '@skillbox/core'
import type {
  GitHubProvider,
  GitProvider,
  GitStatusReport,
  GitPullOutcome,
  GitCommitOutcome,
  GithubConnectionState,
  DeviceFlowStart,
  SecretScanResult,
  SecretScanner,
} from './providers.js'

/**
 * Default providers for the sync pipeline. Each factory adapts the real core
 * implementation (`@skillbox/core`) onto the CLI contract, so the pipeline
 * logic never needs to know about git internals.
 *
 * Default factories use the shipped Core modules. The injectable dynamic
 * loaders remain only as compatibility seams for focused wiring tests.
 */

/** Loads the core package as an opaque module map (injectable in tests). */
export type CoreModuleLoader = () => Promise<Record<string, unknown>>

async function loadSkillboxCore(): Promise<Record<string, unknown>> {
  try {
    return (await import('@skillbox/core')) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

function unavailable(code: 'GIT_UNAVAILABLE' | 'GITHUB_UNAVAILABLE', hint: string): SkillboxError {
  return new SkillboxError(ErrorCode[code], hint)
}

/** Portable check for git's "not a repository" fatal from a failed status. */
function isNotARepositoryError(error: unknown): boolean {
  if (!(error instanceof SkillboxError) || error.code !== ErrorCode.GIT_COMMAND_FAILED) {
    return false
  }
  const stderr = error.context?.['stderr']
  return typeof stderr === 'string' && stderr.includes('not a git repository')
}

/* ---------------------------------------------------------------------- *
 * Git (agent 1 — @skillbox/core/git)
 *
 * `GitClient` takes options and receives `repositoryRoot` per call:
 *   status(root) -> { files, conflicts, staged, unstaged, untracked, clean }
 *   pull(root, opts?), push(root, opts?), commit(root, msg, files?)
 * ---------------------------------------------------------------------- */

interface GitFileShape {
  path: string
  conflict: boolean
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

interface GitClientShape {
  status: (root: string) => Promise<{
    branch?: string
    remote?: { name: string; url: string }
    ahead?: number
    behind?: number
    files: GitFileShape[]
    conflicts: GitFileShape[]
    staged: GitFileShape[]
    unstaged: GitFileShape[]
    untracked: GitFileShape[]
    clean: boolean
  }>
  pull: (root: string, options?: Record<string, unknown>) => Promise<void>
  push: (root: string, options?: Record<string, unknown>) => Promise<void>
  commit: (root: string, message: string, files?: readonly string[]) => Promise<{ hash: string }>
  currentBranch?: (root: string) => Promise<string | undefined>
  isInstalled?: () => Promise<boolean>
}

class GitClientAdapter implements GitProvider {
  constructor(
    private readonly repositoryRoot: string,
    private readonly loadCore: CoreModuleLoader,
    private readonly hint: string,
  ) {}

  private async client(): Promise<GitClientShape> {
    const core = await this.loadCore()
    const GitClient = core.GitClient as (new () => GitClientShape) | undefined
    if (typeof GitClient !== 'function') {
      throw unavailable('GIT_UNAVAILABLE', this.hint)
    }
    return new GitClient()
  }

  async status(): Promise<GitStatusReport> {
    const client = await this.client()
    if (typeof client.isInstalled === 'function' && !(await client.isInstalled())) {
      throw unavailable('GIT_UNAVAILABLE', 'The git binary is not installed or not on PATH.')
    }
    let result: Awaited<ReturnType<GitClientShape['status']>>
    try {
      result = await client.status(this.repositoryRoot)
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

    const branch =
      result.branch ??
      (typeof client.currentBranch === 'function'
        ? await client.currentBranch(this.repositoryRoot)
        : undefined)
    const changed = result.files.filter((file) => !file.conflict)

    const report: GitStatusReport = {
      isRepository: true,
      ahead: result.ahead ?? 0,
      behind: result.behind ?? 0,
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
    const client = await this.client()
    try {
      await client.pull(this.repositoryRoot)
    } catch (error) {
      if (isNotARepositoryError(error)) {
        throw unavailable('GIT_UNAVAILABLE', 'No git repository to pull from.')
      }
      throw error
    }
    const status = await client.status(this.repositoryRoot)
    return {
      conflicts: status.conflicts.map((file) => file.path),
      changedFiles: status.files.map((file) => file.path),
    }
  }

  async commit(message: string, paths: readonly string[]): Promise<GitCommitOutcome> {
    const client = await this.client()
    try {
      const result = await client.commit(this.repositoryRoot, message, paths)
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
    const client = await this.client()
    await client.push(this.repositoryRoot)
  }
}

export function createGitProviderFromCore(
  repositoryRoot: string,
  loadCore: CoreModuleLoader,
  hint: string = 'Git sync is not available in this build yet (V0.2 GitClient not wired).',
): GitProvider {
  return new GitClientAdapter(repositoryRoot, loadCore, hint)
}

export function createDefaultGitProvider(repositoryRoot: string): GitProvider {
  return createGitProviderFromCore(
    repositoryRoot,
    loadSkillboxCore,
    'Git sync is not available in this build yet — the GitClient core module has not landed. ' +
      'Run `skillbox status` to inspect Skills and Agents in the meantime.',
  )
}

export const GITHUB_CLIENT_ID_ENV = 'SKILLBOX_GITHUB_CLIENT_ID'

export interface ProductionGitHubProviderOptions {
  /** Public GitHub App client id; defaults to SKILLBOX_GITHUB_CLIENT_ID. */
  clientId?: string
  /** Test/platform seam. Production defaults to the native credential store. */
  credentialStore?: CredentialStore
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

  async pollDeviceFlow(): Promise<GithubConnectionState> {
    await this.service.pollDeviceAuthorization()
    return (await this.service.getConnectionState()).state
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
  const api = new GitHubApi({ clientId })
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
 * Secret scanner (agent 4 — @skillbox/core/secret-scan)
 *
 * Exported function `scanFiles(files, { root }) -> ScanResult`
 * with `{ findings, blocked, block }`. `block` blocks the pipeline.
 * ---------------------------------------------------------------------- */

interface CoreScanResultShape {
  findings: Array<{
    file: string
    patternId: string
    name: string
    severity: string
    snippet: string
  }>
  block: boolean
}

class SecretScannerAdapter implements SecretScanner {
  constructor(
    private readonly repositoryRoot: string,
    private readonly loadCore: CoreModuleLoader,
  ) {}

  async isReady(): Promise<boolean> {
    const core = await this.loadCore()
    return typeof core.scanFiles === 'function'
  }

  async scanChangedFiles(paths: readonly string[]): Promise<SecretScanResult> {
    const core = await this.loadCore()
    const scanFiles = core.scanFiles as
      ((files: readonly string[], options?: Record<string, unknown>) => unknown) | undefined
    if (typeof scanFiles !== 'function') {
      return { findings: [], blocked: false }
    }
    const result = (await scanFiles(paths, { root: this.repositoryRoot })) as CoreScanResultShape
    return {
      blocked: result.block,
      findings: result.findings.map((finding) => ({
        path: finding.file,
        rule: finding.patternId,
        severity: finding.severity as SecretScanResult['findings'][number]['severity'],
        message: `[${finding.name}] ${finding.snippet}`,
      })),
    }
  }
}

export function createSecretScannerFromCore(
  repositoryRoot: string,
  loadCore: CoreModuleLoader,
): SecretScanner {
  return new SecretScannerAdapter(repositoryRoot, loadCore)
}

export function createDefaultSecretScanner(repositoryRoot: string): SecretScanner {
  return createSecretScannerFromCore(repositoryRoot, loadSkillboxCore)
}
