import {
  AgentRegistry,
  ErrorCode,
  isSkillboxError,
  SkillboxError,
  type ReconcileProblem,
  type ReconcileResult,
  type SkillService,
} from '@skillbox/core'
import { renderTable } from '../table.js'
import type {
  GitHubProvider,
  GitProvider,
  GitStatusReport,
  GithubConnectionState,
  SecretFinding,
  SecretScanner,
  SyncStepId,
  SyncStepStatus,
} from './types.js'

/**
 * Paths skillbox owns inside a repository. Auto-commit only stages these;
 * everything else the user added is left untouched (MVP_TASKS #109).
 */
export const SYNC_MANAGED_PATHS = [
  'skillbox.yaml',
  'skillbox.lock',
  'skills/',
  '.skillbox/',
] as const

export function isManagedSyncPath(relativePath: string): boolean {
  return SYNC_MANAGED_PATHS.some((prefix) => {
    const literal = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    return relativePath === literal || relativePath.startsWith(prefix)
  })
}

export interface SyncServiceOptions {
  repositoryRoot: string
  registry: AgentRegistry
  gitProvider: GitProvider
  githubProvider: GitHubProvider
  secretScanner: SecretScanner
  skills: SkillService
  out: (chunk: string) => void
  /** Poll sleep, injectable so tests don't wait real seconds. */
  sleep?: (ms: number) => Promise<void>
}

export interface SyncResult {
  repository: string
  steps: SyncStepResult[]
  changedFiles: string[]
  detectedAgents: string[]
  findings: SecretFinding[]
  /** True when a skillbox-owned commit was created. */
  committed: boolean
  commitMessage?: string
  pushed: boolean
  problems: ReconcileProblem[]
}

export interface SyncStepResult {
  step: SyncStepId
  status: SyncStepStatus
  detail: string
}

export interface PullResult {
  repository: string
  pulledFiles: string[]
  conflicts: string[]
  reconcile: ReconcileResult
}

export interface PushResult {
  repository: string
  pushed: boolean
  connected: boolean
}

export interface ConnectResult {
  state: GithubConnectionState
  /** True when the account was already connected (no Device Flow ran). */
  alreadyConnected: boolean
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * V0.2 Git Sync orchestration. Runs the fixed
 * `Scan → Detect → Secret Scan → Pull → Resolve → Commit → Push` pipeline
 * plus the single-shot `pull` / `push` / git-status / GitHub Connect flows.
 *
 * Every failure surfaces as a typed `SkillboxError` (with a recovery hint) —
 * nothing is silently swallowed. The pipeline only talks to the injected
 * providers, so it is fully testable with fakes while the core workstreams
 * land.
 */
export class SyncService {
  private readonly repositoryRoot: string
  private readonly registry: AgentRegistry
  private readonly gitProvider: GitProvider
  private readonly githubProvider: GitHubProvider
  private readonly secretScanner: SecretScanner
  private readonly skills: SkillService
  private readonly out: (chunk: string) => void
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: SyncServiceOptions) {
    this.repositoryRoot = options.repositoryRoot
    this.registry = options.registry
    this.gitProvider = options.gitProvider
    this.githubProvider = options.githubProvider
    this.secretScanner = options.secretScanner
    this.skills = options.skills
    this.out = options.out
    this.sleep = options.sleep ?? defaultSleep
  }

  /* ------------------------------------------------------------------ *
   * Full pipeline: skillbox sync
   * ------------------------------------------------------------------ */

  async sync(): Promise<SyncResult> {
    this.out(`  ${'STEP'.padEnd(13)} ${'STATUS'.padEnd(9)} ${'DETAIL'}\n`)
    this.out(`  ${'-----'.padEnd(13)} ${'-------'.padEnd(9)} ${'------------'}\n`)
    const steps: SyncStepResult[] = []
    const changedFiles: string[] = []
    const findings: SecretFinding[] = []

    /* 1. Scan — working tree changes (scanner + git status). */
    const git = await this.gitProvider.status()
    if (!git.isRepository) {
      throw new SkillboxError(
        ErrorCode.GIT_NOT_INITIALIZED,
        `"${this.repositoryRoot}" is not a git repository — run \`git init\` first and connect a remote with \`skillbox connect\`.`,
      )
    }
    changedFiles.push(...git.changedFiles)
    this.recordStep(steps, 'scan', 'ok', `${changedFiles.length} changed file(s)`)

    /* 2. Detect — existing agent detection (agent/registry). */
    const agents = await this.registry.detectAll()
    const detectedAgents = agents.filter((agent) => agent.detected)
    this.recordStep(
      steps,
      'detect',
      'ok',
      `${detectedAgents.length}/${agents.length} agent(s) detected` +
        (detectedAgents.length > 0 ? ` (${detectedAgents.map((a) => a.id).join(', ')})` : ''),
    )

    /* 3. Secret scan — changed files only (agent 4); skip when unwired. */
    if (await this.secretScanner.isReady()) {
      const paths = changedFiles.length > 0 ? changedFiles : []
      const scan = await this.secretScanner.scanChangedFiles(paths)
      findings.push(...scan.findings)
      if (scan.blocked) {
        const blockedPaths = scan.findings
          .filter(
            (finding: SecretFinding) =>
              finding.severity === 'critical' || finding.severity === 'high',
          )
          .map((finding: SecretFinding) => finding.path)
        this.recordStep(
          steps,
          'secret-scan',
          'warning',
          `${findings.length} finding(s) — critical/high findings block the sync`,
        )
        throw new SkillboxError(
          ErrorCode.SECRET_FOUND,
          `Secret scan blocked the sync: ${[...new Set(blockedPaths)].join(', ')}. ` +
            `Review and remove the secrets, or add them to your ignore policy, then re-run \`skillbox sync\`.`,
          { context: { findings: scan.findings } },
        )
      }
      this.recordStep(
        steps,
        'secret-scan',
        'ok',
        `scanned ${paths.length} file(s), ${findings.length} finding(s)`,
      )
    } else {
      this.recordStep(steps, 'secret-scan', 'skipped', 'secret scan engine not wired yet')
    }

    /* 4. Pull — merge remote changes; conflicts abort without overwriting. */
    const pull = await this.gitProvider.pull()
    if (pull.conflicts.length > 0) {
      this.recordStep(steps, 'pull', 'warning', `conflicts in ${pull.conflicts.join(', ')}`)
      throw new SkillboxError(
        ErrorCode.GIT_CONFLICT,
        `Merge conflict in ${pull.conflicts.join(', ')} — resolve the files manually, then re-run ` +
          `\`skillbox sync\`. Nothing was overwritten.`,
        { context: { conflicts: pull.conflicts } },
      )
    }
    this.recordStep(steps, 'pull', 'ok', `${pull.changedFiles.length} remote file(s) merged`)

    /* 5. Resolve — regenerate the lockfile + reconcile agent links. */
    let reconcile: ReconcileResult
    try {
      reconcile = await this.skills.install()
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.MANIFEST_NOT_FOUND) {
        throw new SkillboxError(
          ErrorCode.MANIFEST_NOT_FOUND,
          `No skillbox.yaml in "${this.repositoryRoot}" — create a skill first (` +
            `\`skillbox create <name>\`) or run \`skillbox install\` to restore from a manifest.`,
          { cause: error },
        )
      }
      throw error
    }
    this.recordStep(
      steps,
      'resolve',
      reconcile.problems.length > 0 ? 'warning' : 'ok',
      `lockfile regenerated · ${reconcile.problems.length} problem(s)`,
    )

    /* 6. Commit — skillbox-owned files only, auto-commit policy (#109). */
    const changedManagedCount = changedFiles.filter(isManagedSyncPath).length
    const message =
      changedManagedCount > 0
        ? `skillbox: sync ${changedManagedCount} skill change${changedManagedCount === 1 ? '' : 's'}`
        : 'chore(skillbox): sync skills'
    const pathsToStage = SYNC_MANAGED_PATHS.map((p) => p.replace(/\/$/, ''))
    const commit = await this.gitProvider.commit(message, pathsToStage)
    const commitMessage = commit.committed ? commit.message : undefined
    this.recordStep(
      steps,
      'commit',
      commit.committed ? 'ok' : 'skipped',
      commit.committed
        ? `committed ${commit.shortHash ?? commit.message}`
        : 'no skillbox changes to commit',
    )

    /* 7. Push — require a connected GitHub account first. */
    const state = await this.githubProvider.connectionState()
    if (state !== 'connected') {
      this.recordStep(steps, 'push', 'warning', `github ${state}`)
      throw new SkillboxError(
        ErrorCode.GITHUB_NOT_CONNECTED,
        `GitHub is ${state} — run \`skillbox connect\` to authorize Skillbox, then re-run \`skillbox sync\`.`,
        { context: { state } },
      )
    }
    await this.gitProvider.push()
    this.recordStep(steps, 'push', 'ok', 'pushed to remote')

    const result: SyncResult = {
      repository: this.repositoryRoot,
      steps,
      changedFiles,
      detectedAgents: detectedAgents.map((agent) => agent.id),
      findings,
      committed: commit.committed,
      pushed: true,
      problems: reconcile.problems,
    }
    if (commitMessage !== undefined) {
      result.commitMessage = commitMessage
    }
    return result
  }

  /* ------------------------------------------------------------------ *
   * Single-shot git operations
   * ------------------------------------------------------------------ */

  /** `git status` facts for the `status` command. */
  async gitStatus(): Promise<GitStatusReport> {
    return this.gitProvider.status()
  }

  /** `skillbox pull`: fetch+merge, then reconcile + lockfile update. */
  async pull(): Promise<PullResult> {
    const git = await this.gitProvider.status()
    if (!git.isRepository) {
      throw new SkillboxError(
        ErrorCode.GIT_NOT_INITIALIZED,
        `"${this.repositoryRoot}" is not a git repository — run \`git init\` first.`,
      )
    }
    if (git.remote === undefined) {
      throw new SkillboxError(
        ErrorCode.GIT_REMOTE_NOT_FOUND,
        `No git remote configured — bind one with \`skillbox connect\` (or \`git remote add origin <url>\`).`,
      )
    }
    const outcome = await this.gitProvider.pull()
    if (outcome.conflicts.length > 0) {
      throw new SkillboxError(
        ErrorCode.GIT_CONFLICT,
        `Merge conflict in ${outcome.conflicts.join(', ')} — resolve manually, then re-run \`skillbox pull\`.`,
        { context: { conflicts: outcome.conflicts } },
      )
    }
    const reconcile = await this.skills.install()
    return {
      repository: this.repositoryRoot,
      pulledFiles: outcome.changedFiles,
      conflicts: outcome.conflicts,
      reconcile,
    }
  }

  /** `skillbox push`: gate on a connected GitHub account, then push. */
  async push(): Promise<PushResult> {
    const git = await this.gitProvider.status()
    if (!git.isRepository) {
      throw new SkillboxError(
        ErrorCode.GIT_NOT_INITIALIZED,
        `"${this.repositoryRoot}" is not a git repository — run \`git init\` first.`,
      )
    }
    if (git.remote === undefined) {
      throw new SkillboxError(
        ErrorCode.GIT_REMOTE_NOT_FOUND,
        `No git remote configured — bind one with \`skillbox connect\` (or \`git remote add origin <url>\`).`,
      )
    }
    const state = await this.githubProvider.connectionState()
    if (state !== 'connected') {
      throw new SkillboxError(
        ErrorCode.GITHUB_NOT_CONNECTED,
        `GitHub is ${state} — run \`skillbox connect\` to authorize Skillbox before pushing.`,
        { context: { state } },
      )
    }
    await this.gitProvider.push()
    return { repository: this.repositoryRoot, pushed: true, connected: true }
  }

  /* ------------------------------------------------------------------ *
   * GitHub Connect / Disconnect (agent 2 — Device Flow)
   * ------------------------------------------------------------------ */

  /** `skillbox connect`: start the Device Flow and poll until connected. */
  async connect(): Promise<ConnectResult> {
    const initial = await this.githubProvider.connectionState()
    if (initial === 'connected') {
      return { state: 'connected', alreadyConnected: true }
    }
    const start = await this.githubProvider.startDeviceFlow()
    this.out(
      `Authorize the Skillbox GitHub App to continue.\n` +
        `  Verification URL  ${start.verificationUri}\n` +
        `  Code              ${start.userCode}\n`,
    )
    this.out('Waiting for authorization')

    const deadline = Date.now() + start.expiresInMs
    let last: GithubConnectionState = initial
    for (;;) {
      await this.sleep(start.intervalMs)
      let state: GithubConnectionState
      try {
        state = await this.githubProvider.pollDeviceFlow()
      } catch (error) {
        this.out('\n')
        throw error
      }
      if (state !== last) {
        this.out(`\n  status: ${state}`)
        last = state
      } else {
        this.out('.')
      }
      if (state === 'connected') {
        this.out('\n')
        return { state: 'connected', alreadyConnected: false }
      }
      if (state === 'refresh-required' || state === 'reauthorization-required') {
        this.out('\n')
        throw new SkillboxError(
          ErrorCode.GITHUB_NOT_CONNECTED,
          `GitHub authorization is ${state} — re-run \`skillbox connect\` and approve again.`,
          { context: { state } },
        )
      }
      if (Date.now() > deadline) {
        this.out('\n')
        throw new SkillboxError(
          ErrorCode.GITHUB_AUTHORIZATION_EXPIRED,
          `The device code expired before authorization — re-run \`skillbox connect\` for a fresh code. ` +
            `Nothing was changed in this repository.`,
        )
      }
    }
  }

  /** `skillbox disconnect`: remove only local credentials/metadata. */
  async disconnect(): Promise<void> {
    await this.githubProvider.disconnect()
  }

  /* ------------------------------------------------------------------ */

  private recordStep(
    steps: SyncStepResult[],
    step: SyncStepId,
    status: SyncStepStatus,
    detail: string,
  ): void {
    steps.push({ step, status, detail })
    this.out(`  ${step.padEnd(13)} ${status.padEnd(9)} ${detail}\n`)
  }
}

/** Renders the executed pipeline as an aligned table (table.ts style). */
export function renderSyncSteps(steps: readonly SyncStepResult[]): string {
  return renderTable(
    ['STEP', 'STATUS', 'DETAIL'],
    steps.map((step) => [step.step, step.status, step.detail]),
  )
}
