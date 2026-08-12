import { Command } from 'commander'
import {
  compareManifestToLockfile,
  createRepositorySync,
  createDefaultAgentRegistry,
  ErrorCode,
  isSkillboxError,
  readLockfile,
  readManifest,
  resolveSkillboxHome,
  SkillboxError,
  type AgentDetectionSummary,
  type AgentRegistry,
  type ReconcileProblem,
  type RepositorySync,
  type RepositorySyncEvent,
  type SkillboxErrorCode,
  type SkillboxLockfile,
  type SkillboxManifest,
  SkillService,
  StatusService,
  version,
} from '@skillbox/core'
import type { RepositoryStatus, SkillStatusEntry } from '@skillbox/core'
import { renderTable } from './table.js'
import type { InteractivePrompt } from './interactive/prompts.js'
import { createClackPrompts, isInteractiveTTY } from './interactive/prompts.js'
import {
  registerWebCommand,
  startWebServer,
  webOptionsFromFlags,
  type WebCommandFlags,
} from './web/main.js'
import {
  createDefaultGitHubProvider,
  createDefaultGitProvider,
  createDefaultSecretScanner,
  SyncService,
  type GitHubProvider,
  type GitProvider,
  type GitStatusReport,
  type SecretScanner,
} from './sync/index.js'
import {
  createDefaultInstallService,
  createDefaultRegistryClient,
  createDefaultSecurityScanner,
  createDefaultSourceParser,
  MarketplaceService,
  renderAddSummary,
  renderOutdatedTable,
  renderSearchTable,
  renderUpdateSummary,
  type InstallService,
  type RegistryClient,
  type SecurityScanner,
  type SourceParser,
} from './marketplace/index.js'
import {
  createDefaultDiffProvider,
  createDefaultLifecycleProvider,
  createDefaultMergeProvider,
  renderDiff,
  renderEditSummary,
  renderForkSummary,
  renderMergeOutcome,
  renderVendorSummary,
  SkillLifecycleService,
  type DiffProvider,
  type EditorLauncher,
  type LifecycleProvider,
  type MergeProvider,
} from './skill-lifecycle/index.js'
import {
  createDefaultRollbackProvider,
  renderRollbackSummary,
  type RollbackProvider,
} from './operations/index.js'
import {
  createDefaultDiagnosticsProvider,
  renderDiagnostics,
  type DiagnosticsProvider,
} from './diagnostics/index.js'

/** V0.3 marketplace provider overrides (search/add/outdated/update/cache clean). */
export interface MarketplaceDeps {
  sourceParser?: SourceParser
  registryClient?: RegistryClient
  installer?: InstallService
  scanner?: SecurityScanner
}

/** V0.4 skill-lifecycle provider overrides (fork/vendor/edit/diff/merge). */
export interface LifecycleDeps {
  /** Agent 1's fork/vendor/detect/restore provider. */
  lifecycle?: LifecycleProvider
  /** Agent 2's diff provider. */
  diff?: DiffProvider
  /** Agent 2's merge provider. */
  merge?: MergeProvider
  /** Editor launcher; defaults to $EDITOR/$VISUAL (tests inject a fake). */
  openEditor?: EditorLauncher
}

export interface CliDeps {
  /** Repository root; defaults to the current working directory. */
  repositoryRoot?: string
  /** Skillbox home root; defaults to `$HOME/.skillbox` (or `SKILLBOX_HOME`). */
  homeRoot?: string
  /** Agent registry; defaults to the built-in Claude + Codex adapters. */
  registry?: AgentRegistry
  stdout?: (chunk: string) => void
  stderr?: (chunk: string) => void
  /** Prompt implementation used by the interactive mode (defaults to @clack/prompts). */
  prompts?: InteractivePrompt
  /** Override the interactive-terminal check (used by tests). */
  isInteractive?: boolean
  /** Git provider; defaults to the core GitClient-backed provider (V0.2). */
  gitProvider?: GitProvider
  /** GitHub provider; defaults to the core GitHub service (V0.2). */
  githubProvider?: GitHubProvider
  /** Secret scanner; defaults to the core secret-scan module (V0.2). */
  secretScanner?: SecretScanner
  /** Deep repository orchestration seam; defaults to Core production wiring. */
  repositorySync?: RepositorySync
  /** V0.3 marketplace providers; default-constructed from @skillbox/core. */
  marketplace?: MarketplaceDeps
  /** V0.4 lifecycle providers; default-constructed from @skillbox/core. */
  lifecycle?: LifecycleDeps
  /** User-level operation rollback; default-constructed from @skillbox/core. */
  rollbackProvider?: RollbackProvider
  /** Environment diagnostics; default-constructed from @skillbox/core. */
  diagnosticsProvider?: DiagnosticsProvider
}

export interface CliContext {
  repositoryRoot: string
  homeRoot: string
  registry: AgentRegistry
  out: (chunk: string) => void
  err: (chunk: string) => void
  gitProvider: GitProvider
  githubProvider: GitHubProvider
  secretScanner: SecretScanner
  repositorySync?: RepositorySync
  /** V0.3 marketplace provider overrides; defaults applied in buildProgram. */
  marketplace?: MarketplaceDeps
  /** V0.4 lifecycle provider overrides; defaults applied in buildProgram. */
  lifecycle?: LifecycleDeps
  rollbackProvider?: RollbackProvider
  diagnosticsProvider?: DiagnosticsProvider
  /** Prompt implementation for the interactive `add` flow. */
  prompts?: InteractivePrompt
  /** Override the interactive-terminal check (used by tests). */
  isInteractive?: boolean
}

export function buildContext(deps: CliDeps = {}): CliContext {
  const repositoryRoot = deps.repositoryRoot ?? process.cwd()
  const homeRoot = deps.homeRoot ?? resolveSkillboxHome()
  const registry = deps.registry ?? createDefaultAgentRegistry()
  const out = deps.stdout ?? ((chunk) => process.stdout.write(chunk))
  const err = deps.stderr ?? ((chunk) => process.stderr.write(chunk))
  const context: CliContext = {
    repositoryRoot,
    homeRoot,
    registry,
    out,
    err,
    gitProvider: deps.gitProvider ?? createDefaultGitProvider(repositoryRoot),
    githubProvider: deps.githubProvider ?? createDefaultGitHubProvider(homeRoot),
    secretScanner: deps.secretScanner ?? createDefaultSecretScanner(repositoryRoot),
  }
  if (deps.repositorySync !== undefined) {
    context.repositorySync = deps.repositorySync
  } else if (deps.gitProvider === undefined && deps.githubProvider === undefined) {
    context.repositorySync = createRepositorySync({
      repositoryRoot,
      homeRoot,
      onEvent: (event) => renderRepositorySyncEvent(out, event),
    })
  }
  if (deps.marketplace !== undefined) {
    context.marketplace = deps.marketplace
  }
  if (deps.lifecycle !== undefined) {
    context.lifecycle = deps.lifecycle
  }
  if (deps.rollbackProvider !== undefined) {
    context.rollbackProvider = deps.rollbackProvider
  }
  if (deps.diagnosticsProvider !== undefined) {
    context.diagnosticsProvider = deps.diagnosticsProvider
  }
  if (deps.prompts !== undefined) {
    context.prompts = deps.prompts
  }
  if (deps.isInteractive !== undefined) {
    context.isInteractive = deps.isInteractive
  }
  return context
}

function renderRepositorySyncEvent(out: (chunk: string) => void, event: RepositorySyncEvent): void {
  if (event.type === 'authorization-required') {
    out(
      `Authorize the Skillbox GitHub App to continue.\n` +
        `  Verification URL  ${event.authorization.verificationUri}\n` +
        `  Code              ${event.authorization.userCode}\n` +
        `Waiting for authorization\n`,
    )
  }
}

/** Resolves the marketplace service, merging CLI-provided overrides + defaults. */
function buildMarketplace(ctx: CliContext): MarketplaceService {
  const overrides = ctx.marketplace ?? {}
  return new MarketplaceService({
    repositoryRoot: ctx.repositoryRoot,
    homeRoot: ctx.homeRoot,
    registry: ctx.registry,
    sourceParser: overrides.sourceParser ?? createDefaultSourceParser(),
    registryClient: overrides.registryClient ?? createDefaultRegistryClient(ctx.homeRoot),
    installer:
      overrides.installer ??
      createDefaultInstallService({
        repositoryRoot: ctx.repositoryRoot,
        homeRoot: ctx.homeRoot,
      }),
    scanner: overrides.scanner ?? createDefaultSecurityScanner(),
    prompts: ctx.prompts ?? createClackPrompts(),
    isInteractive: ctx.isInteractive ?? isInteractiveTTY(),
    out: ctx.out,
  })
}

/** Resolves the skill-lifecycle service, merging CLI overrides + defaults. */
function buildLifecycleService(
  ctx: CliContext,
  statusService: StatusService,
): SkillLifecycleService {
  const overrides = ctx.lifecycle ?? {}
  return new SkillLifecycleService({
    repositoryRoot: ctx.repositoryRoot,
    homeRoot: ctx.homeRoot,
    status: statusService,
    lifecycle: overrides.lifecycle ?? createDefaultLifecycleProvider(),
    diff: overrides.diff ?? createDefaultDiffProvider(),
    merge: overrides.merge ?? createDefaultMergeProvider(),
    prompts: ctx.prompts ?? createClackPrompts(),
    isInteractive: ctx.isInteractive ?? isInteractiveTTY(),
    out: ctx.out,
    ...(overrides.openEditor === undefined ? {} : { openEditor: overrides.openEditor }),
  })
}

function printJson(out: (chunk: string) => void, value: unknown): void {
  out(`${JSON.stringify(value, null, 2)}\n`)
}

function reportProblems(ctx: CliContext, problems: readonly ReconcileProblem[]): void {
  for (const problem of problems) {
    const alias = problem.alias === undefined ? '' : ` ${problem.alias}`
    ctx.err(`  ${problem.code}${alias}: ${problem.message}\n`)
  }
}

function skillTable(skills: readonly SkillStatusEntry[]): string {
  const hasReasons = skills.some((skill) => skill.message !== undefined)
  const headers = hasReasons ? ['NAME', 'MODE', 'STATUS', 'REASON'] : ['NAME', 'MODE', 'STATUS']
  const rows = skills.map((skill) =>
    hasReasons
      ? [skill.name, skill.mode, skill.status, skill.message ?? '']
      : [skill.name, skill.mode, skill.status],
  )
  return renderTable(headers, rows)
}

function agentTable(detected: readonly AgentDetectionSummary[]): string {
  if (detected.length === 0) {
    return '(no agents registered)'
  }
  const rows = detected.map((agent) => [
    agent.name,
    agent.detected ? 'detected' : 'not found',
    agent.skillCount > 0 ? String(agent.skillCount) : '-',
  ])
  return renderTable(['AGENT', 'STATUS', 'SKILLS'], rows)
}

function bulletList(names: readonly string[]): string {
  if (names.length === 0) {
    return '  (none)'
  }
  return names.map((name) => `  ${name}`).join('\n')
}

function statusOverview(report: RepositoryStatus): string {
  return renderTable(
    ['FIELD', 'STATE', 'VALUE'],
    [
      ['Repository', '', report.repositoryRoot],
      ['Manifest', report.manifestPresent ? 'present' : 'missing', report.manifestPath],
      ['Lockfile', report.lockfilePresent ? 'present' : 'missing', report.lockfilePath],
      ['Skills', String(report.skills.length), ''],
    ],
  )
}

function gitOverview(git: GitStatusReport | null): string {
  if (git === null) {
    return '  (git sync not available in this build)'
  }
  if (!git.isRepository) {
    return '  (not a git repository)'
  }
  const rows: [string, string, string][] = [
    ['Branch', '', git.branch ?? '(detached)'],
    [
      'Remote',
      git.remote !== undefined ? 'connected' : 'none',
      git.remote !== undefined ? `${git.remote.name} → ${git.remote.url}` : '',
    ],
    ['Ahead/behind', '', `${git.ahead}/${git.behind}`],
    ['Modified files', git.changedFiles.length > 0 ? String(git.changedFiles.length) : 'clean', ''],
  ]
  if (git.conflicts.length > 0) {
    rows.push(['Conflicts', 'yes', git.conflicts.join(', ')])
  }
  return renderTable(['FIELD', 'STATE', 'VALUE'], rows)
}

/**
 * `install --frozen-lockfile` guard: the manifest and lockfile must agree,
 * and the lockfile must exist. Fails with `LOCKFILE_OUTDATED` (regenerate via
 * `skillbox sync`) or `LOCKFILE_NOT_FOUND` (run sync first) before reconcile.
 */
async function assertLockfileConsistent(repositoryRoot: string): Promise<void> {
  let manifest: SkillboxManifest
  try {
    manifest = await readManifest(repositoryRoot)
  } catch (error) {
    if (isSkillboxError(error) && error.code === ErrorCode.MANIFEST_NOT_FOUND) {
      throw new SkillboxError(
        ErrorCode.MANIFEST_NOT_FOUND,
        `No skillbox.yaml in "${repositoryRoot}" — run \`skillbox create <name>\` first.`,
        { cause: error },
      )
    }
    throw error
  }
  let lockfile: SkillboxLockfile
  try {
    lockfile = await readLockfile(repositoryRoot)
  } catch (error) {
    if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
      throw new SkillboxError(
        ErrorCode.LOCKFILE_NOT_FOUND,
        `No skillbox.lock in "${repositoryRoot}" — run \`skillbox sync\` (or \`skillbox install\` without ` +
          `--frozen-lockfile) to generate it first.`,
        { cause: error },
      )
    }
    throw error
  }
  const check = compareManifestToLockfile(manifest, lockfile)
  if (check.outdated) {
    const reasons: string[] = []
    if (check.missingFromLockfile.length > 0) {
      reasons.push(`skills missing from lockfile: ${check.missingFromLockfile.join(', ')}`)
    }
    if (check.mismatchedSources.length > 0) {
      reasons.push(`source mismatch: ${check.mismatchedSources.join(', ')}`)
    }
    throw new SkillboxError(
      ErrorCode.LOCKFILE_OUTDATED,
      `skillbox.lock is out of date (${reasons.join('; ')}) — run \`skillbox sync\` to regenerate it, then retry.`,
      { context: { ...check } },
    )
  }
}

/** Maps a reconcile problem onto a typed error for `install --ci`. */
function problemAsError(problem: ReconcileProblem): SkillboxError {
  const known = new Set<string>(Object.values(ErrorCode))
  const code: SkillboxErrorCode = known.has(problem.code)
    ? (problem.code as SkillboxErrorCode)
    : ErrorCode.INVALID_MANIFEST
  return new SkillboxError(
    code,
    `--ci install failed on reconcile problem ${problem.code}: ${problem.message}`,
    { context: { code: problem.code } },
  )
}

function buildSyncService(ctx: CliContext, skills: SkillService): SyncService {
  return new SyncService({
    repositoryRoot: ctx.repositoryRoot,
    registry: ctx.registry,
    gitProvider: ctx.gitProvider,
    githubProvider: ctx.githubProvider,
    secretScanner: ctx.secretScanner,
    skills,
    out: ctx.out,
  })
}

export function buildProgram(ctx: CliContext): Command {
  const skills = new SkillService({
    repositoryRoot: ctx.repositoryRoot,
    homeRoot: ctx.homeRoot,
    registry: ctx.registry,
  })
  const statusService = new StatusService({
    repositoryRoot: ctx.repositoryRoot,
    registry: ctx.registry,
  })
  const sync = buildSyncService(ctx, skills)

  const program = new Command()
  program
    .name('skillbox')
    .description(
      'Manage the skills your AI agents use.\n  Run without arguments to open the interactive menu.',
    )
    .version(version, '-v, --version')
    .exitOverride()
    .configureOutput({
      writeOut: (chunk) => ctx.out(chunk),
      writeErr: (chunk) => ctx.err(chunk),
    })
    .showHelpAfterError('(run "skillbox --help" for usage)')
    .action(() => {
      program.outputHelp()
    })

  program
    .command('list')
    .description('List every skill in the current repository')
    .option('--json', 'emit machine-readable JSON instead of a table')
    .action(async (options: { json?: boolean }) => {
      const report = await statusService.status()
      if (options.json === true) {
        printJson(ctx.out, { skills: report.skills })
        return
      }
      ctx.out(`${skillTable(report.skills)}\n`)
    })

  program
    .command('agents')
    .description('Detect the configured agents and their skill counts')
    .option('--json', 'emit JSON instead of a table')
    .action(async (options: { json?: boolean }) => {
      const detected = await ctx.registry.detectAll()
      if (options.json === true) {
        printJson(ctx.out, { agents: detected })
        return
      }
      ctx.out(`${agentTable(detected)}\n`)
    })

  program
    .command('create <name>')
    .description('Scaffold a new skill and register it with the repository')
    .option('-d, --description <text>', 'short description for the skill')
    .action(async (name: string, options: { description?: string }) => {
      const input: { name: string; description?: string } = { name }
      if (options.description !== undefined) {
        input.description = options.description
      }
      const result = await skills.createSkill(input)
      ctx.out(
        `Created skill "${result.name}" (local)\n  code     ${result.path}\n  library  ${result.materialized.path}\n`,
      )
    })

  program
    .command('remove <name>')
    .description('Remove a skill (config only by default)')
    .option('-f, --delete-files', 'also delete files from the repository')
    .action(async (name: string, options: { deleteFiles?: boolean }) => {
      const input: { name: string; deleteFiles?: boolean } = { name }
      if (options.deleteFiles === true) {
        input.deleteFiles = true
      }
      const result = await skills.removeSkill(input)
      ctx.out(`Removed skill "${result.name}"`)
      if (result.filesRemoved === true && result.filesPath !== undefined) {
        ctx.out(` (config + files at ${result.filesPath})`)
      } else {
        ctx.out(' (config only, files kept)')
      }
      ctx.out('\n')
    })

  program
    .command('enable <name>')
    .description('Enable a skill for an agent')
    .requiredOption('-a, --agent <agent>', 'agent id (e.g. claude, codex)')
    .action(async (name: string, options: { agent: string }) => {
      const result = await skills.enableSkill({ name, agent: options.agent })
      ctx.out(
        `Enabled "${result.name}" for agent "${options.agent}"${result.manifestChanged ? '' : ' (already enabled)'}\n`,
      )
      reportProblems(ctx, result.reconcile.problems)
    })

  program
    .command('disable <name>')
    .description('Disable a skill for an agent')
    .requiredOption('-a, --agent <agent>', 'agent to disable the skill for')
    .action(async (name: string, options: { agent: string }) => {
      const result = await skills.disableSkill({ name, agent: options.agent })
      ctx.out(
        `Disabled "${result.name}" for agent "${options.agent}"${result.manifestChanged ? '' : ' (was not enabled)'}\n`,
      )
      reportProblems(ctx, result.reconcile.problems)
    })

  program
    .command('install')
    .description(
      'Install/restore the repository (reconcile skills and agent links; --frozen-lockfile never touches skillbox.lock)',
    )
    .option(
      '--frozen-lockfile',
      'require manifest and lockfile to agree; never modify skillbox.lock',
    )
    .option('--ci', 'frozen-lockfile + fail on any reconcile problem (CI-safe)')
    .action(async (options: { frozenLockfile?: boolean; ci?: boolean }) => {
      const frozen = options.frozenLockfile === true || options.ci === true
      if (frozen) {
        await assertLockfileConsistent(ctx.repositoryRoot)
      }
      const report = await skills.install()
      if (options.ci === true && report.problems.length > 0) {
        const first = report.problems[0]
        if (first === undefined) {
          throw new SkillboxError(
            ErrorCode.INVALID_MANIFEST,
            '--ci install failed with an unknown reconcile problem',
          )
        }
        throw problemAsError(first)
      }
      ctx.out(`Reconciled "${report.repository}"\n`)
      ctx.out(
        `  skills   ${report.skills.length}\n  problems ${report.problems.length}\n  changed  ${report.changed ? 'yes' : 'no'}\n`,
      )
      reportProblems(ctx, report.problems)
    })

  program
    .command('status')
    .description('Show the full repository status (Repository, Skills, Agents, Git remote state)')
    .option('--json', 'emit JSON instead of human-readable sections')
    .action(async (options: { json?: boolean }) => {
      const report = await statusService.status()
      let git: GitStatusReport | null = null
      try {
        git = await sync.gitStatus()
      } catch {
        git = null
      }
      if (options.json === true) {
        printJson(ctx.out, { ...report, git })
        return
      }
      ctx.out(`${statusOverview(report)}\n`)
      ctx.out(`\nSkills\n${skillTable(report.skills)}\n`)
      ctx.out(`\nAgents\n${agentTable(report.agents)}\n`)
      ctx.out(`\nGit\n${gitOverview(git)}\n`)
      ctx.out(`\nModified skills\n${bulletList(report.modified)}`)
      // V0.4: a merge in conflict marks the skill `conflict` (agent 2's status
      // computation). The Skills table above already renders MODE (incl.
      // forked/vendored) and STATUS (incl. conflict) from the core report;
      // this section lists the conflicting names for quick triage.
      ctx.out(
        `\nConflicting skills\n${bulletList(report.skills.filter((skill) => skill.status === 'conflict').map((skill) => skill.name))}`,
      )
      ctx.out(`\nBroken skills\n${bulletList(report.broken)}\n`)
    })

  // V0.2 — Git Sync (GAP_ANALYSIS §2.3). The pipeline is executed by
  // SyncService; the commands only render results and surface typed errors.
  program
    .command('sync')
    .description('Synchronize this repository with your other devices')
    .action(async () => {
      if (ctx.repositorySync !== undefined) {
        const outcome = await ctx.repositorySync.sync()
        if (outcome.kind === 'completed') {
          ctx.out(`\nSync complete · automatically merged ${outcome.summary.automaticallyMerged} change(s)\n`)
          return
        }
        if (outcome.kind === 'conflicts') {
          ctx.out(`\n${outcome.session.conflicts.length} skill(s) need a decision. Run \`skillbox conflicts\`.\n`)
          process.exitCode = 3
          return
        }
        ctx.out(`\nSync needs attention: ${outcome.recovery.message}\n`)
        process.exitCode = 3
        return
      }
      const result = await sync.sync()
      ctx.out(
        `\nSync complete for "${result.repository}" · ${result.committed ? 'committed' : 'no commit'} · ${result.pushed ? 'pushed' : 'not pushed'}\n`,
      )
      if (result.problems.length > 0) {
        ctx.out('\nReconcile problems\n')
        reportProblems(ctx, result.problems)
      }
    })

  program
    .command('conflicts')
    .description('Show or resolve pending multi-device sync decisions')
    .option('--session <id>', 'conflict session id')
    .option('--conflict <choice>', 'advanced choice: local, remote, or keep-both')
    .action(async (options: { session?: string; conflict?: string }) => {
      if (ctx.repositorySync === undefined) {
        throw new SkillboxError(ErrorCode.SYNC_CONFLICT_SESSION_NOT_FOUND, 'No sync conflict session is available.', { recoverable: true })
      }
      if (options.session === undefined || options.conflict === undefined) {
        ctx.out('No pending conflict details are available in this command context. Run `skillbox sync` first.\n')
        return
      }
      if (!['local', 'remote', 'keep-both'].includes(options.conflict)) {
        throw new SkillboxError(ErrorCode.SYNC_INVALID_CONFLICT_RESOLUTION, 'Choose local, remote, or keep-both.', { recoverable: true })
      }
      const outcome = await ctx.repositorySync.resolveConflicts({
        sessionId: options.session,
        resolutions: {},
      })
      ctx.out(outcome.kind === 'completed' ? 'Conflict decisions applied.\n' : 'Conflict decisions need attention.\n')
    })

  program
    .command('pull')
    .description('Fetch + merge remote changes, then reconcile and regenerate the lockfile')
    .action(async () => {
      const result = await sync.pull()
      ctx.out(
        `Pulled ${result.pulledFiles.length} file(s) for "${result.repository}"\n  skills   ${result.reconcile.skills.length}\n  problems ${result.reconcile.problems.length}\n  changed  ${result.reconcile.changed ? 'yes' : 'no'}\n`,
      )
      reportProblems(ctx, result.reconcile.problems)
    })

  program
    .command('push')
    .description('Push local commits to the remote (requires a connected GitHub account)')
    .action(async () => {
      const result = await sync.push()
      if (result.pushed) {
        ctx.out(`Pushed "${result.repository}" to the remote.\n`)
      }
    })

  program
    .command('connect')
    .description('Connect a GitHub account via Device Flow so Git Sync can push')
    .action(async () => {
      if (ctx.repositorySync !== undefined) {
        const result = await ctx.repositorySync.connect()
        ctx.out(
          `\nConnected GitHub account "${result.account.login}" to "${result.repository.fullName}".` +
            `\n  origin  ${result.local.remote.action} (${result.local.remote.url})\n`,
        )
        return
      }
      const result = await sync.connect()
      ctx.out(
        result.alreadyConnected
          ? '\nAlready connected to GitHub — nothing to do.\n'
          : '\nConnected to GitHub.\n',
      )
    })

  program
    .command('disconnect')
    .description('Disconnect GitHub — removes only local credentials and connection metadata')
    .action(async () => {
      if (ctx.repositorySync !== undefined) {
        await ctx.repositorySync.disconnect()
      } else {
        await sync.disconnect()
      }
      ctx.out('Disconnected from GitHub. Local and remote repositories were preserved.\n')
    })

  // V0.3 — Marketplace (GAP_ANALYSIS §3): search / add / outdated / update /
  // cache clean. The flows live in MarketplaceService; commands only render.
  const marketplace = buildMarketplace(ctx)

  program
    .command('search [query]')
    .description(
      'Search the skill marketplace (skills.sh + GitHub); empty query shows popular skills',
    )
    .option('--json', 'emit JSON instead of a table')
    .action(async (query: string | undefined, options: { json?: boolean }) => {
      const results = await marketplace.search(query ?? '')
      if (options.json === true) {
        printJson(ctx.out, { query: query ?? '', results })
        return
      }
      if (results.length === 0) {
        ctx.out('(no skills found)\n')
        ctx.out('Usage: skillbox search <query> — e.g. `skillbox search react`\n')
        return
      }
      ctx.out(`${renderSearchTable(results)}\n`)
    })

  program
    .command('add <source>')
    .description(
      'Add a skill from the marketplace: resolve → security review → pick agent → install',
    )
    .option('--agent <agent>', 'agent to install for (skips the interactive picker)')
    .option('--name <alias>', 'alias to install under (defaults to the source name)')
    .option('--yes', 'confirm HIGH-risk installs without prompting (CI)')
    .action(async (source: string, options: { agent?: string; name?: string; yes?: boolean }) => {
      const input: { source: string; agent?: string; alias?: string; yes?: boolean } = {
        source,
        yes: options.yes === true,
      }
      if (options.agent !== undefined) {
        input.agent = options.agent
      }
      if (options.name !== undefined) {
        input.alias = options.name
      }
      const outcome = await marketplace.add(input)
      ctx.out(`${renderAddSummary(outcome)}\n`)
    })

  program
    .command('outdated')
    .description('Compare installed revisions against the latest upstream (M16.1)')
    .option('--json', 'emit JSON instead of a table')
    .action(async (options: { json?: boolean }) => {
      const entries = await marketplace.outdated()
      if (options.json === true) {
        printJson(ctx.out, { entries })
        return
      }
      ctx.out(`${renderOutdatedTable(entries)}\n`)
    })

  program
    .command('update <name>')
    .description(
      'Update a managed skill to the latest upstream revision; agent links are preserved (M16.2)',
    )
    .option('--yes', 'confirm HIGH-risk updates without prompting (CI)')
    .action(async (name: string, options: { yes?: boolean }) => {
      const outcome = await marketplace.update({ name, yes: options.yes === true })
      ctx.out(`${renderUpdateSummary(outcome)}\n`)
    })

  const cacheCommand = program.command('cache').description('Manage the skillbox download cache')
  cacheCommand
    .command('clean')
    .description('Remove all cached skill downloads')
    .action(async () => {
      const outcome = await marketplace.cacheClean()
      ctx.out(`Cleared ${outcome.cleared} cache entr${outcome.cleared === 1 ? 'y' : 'ies'}.\n`)
    })

  // V0.4 — Skill Lifecycle (GAP_ANALYSIS §4): fork / vendor / edit / diff /
  // merge. The flows live in SkillLifecycleService; commands only render.
  const lifecycle = buildLifecycleService(ctx, statusService)

  program
    .command('fork <name>')
    .description(
      'Fork a managed skill into the repository (M17.1): copy the runtime, snapshot the base revision, keep upstream tracking',
    )
    .action(async (name: string) => {
      const outcome = await lifecycle.fork({ name })
      ctx.out(`${renderForkSummary(outcome)}\n`)
    })

  program
    .command('vendor <name>')
    .description(
      'Vendor a managed or forked skill (M18): localize the runtime and clear upstream tracking',
    )
    .action(async (name: string) => {
      const outcome = await lifecycle.vendor({ name })
      ctx.out(`${renderVendorSummary(outcome)}\n`)
    })

  program
    .command('edit <name>')
    .description(
      'Open a skill in your editor (M17.2); editing a managed skill converts it to a fork',
    )
    .option('--yes', 'confirm the fork conversion without prompting (CI)')
    .action(async (name: string, options: { yes?: boolean }) => {
      const outcome = await lifecycle.edit({ name, yes: options.yes === true })
      ctx.out(`${renderEditSummary(outcome)}\n`)
    })

  program
    .command('diff <name>')
    .description(
      'Show local changes (M19.4): managed → current vs latest; forked → base/local/upstream',
    )
    .option('--json', 'emit JSON instead of text')
    .action(async (name: string, options: { json?: boolean }) => {
      const diff = await lifecycle.diff({ name })
      if (options.json === true) {
        printJson(ctx.out, diff)
        return
      }
      ctx.out(`${renderDiff(diff)}\n`)
    })

  program
    .command('merge <name>')
    .description(
      'Merge upstream changes into a fork (M20, 3-way); --continue finishes a resolved merge, --abort restores the pre-merge state',
    )
    .option('--continue', 'finish the merge after resolving conflicts')
    .option('--abort', 'cancel the merge and restore the pre-merge state')
    .action(async (name: string, options: { continue?: boolean; abort?: boolean }) => {
      const action =
        options.continue === true ? 'continue' : options.abort === true ? 'abort' : 'merge'
      const outcome = await lifecycle.merge({ name, action })
      ctx.out(`${renderMergeOutcome(outcome)}\n`)
    })

  program
    .command('rollback [operationId]')
    .description('Restore the latest eligible operation backup, or a specified operation id')
    .action(async (operationId: string | undefined) => {
      const result = await (
        ctx.rollbackProvider ?? createDefaultRollbackProvider()
      ).rollbackOperation({
        repositoryRoot: ctx.repositoryRoot,
        homeRoot: ctx.homeRoot,
        ...(operationId === undefined ? {} : { operationId }),
      })
      ctx.out(`${renderRollbackSummary(result)}\n`)
    })

  program
    .command('doctor')
    .description('Check local prerequisites and Skillbox repository state')
    .option('--json', 'emit the Core diagnostic report as JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await (ctx.diagnosticsProvider ?? createDefaultDiagnosticsProvider()).collect({
        repositoryRoot: ctx.repositoryRoot,
      })
      if (options.json === true) {
        printJson(ctx.out, report)
        return
      }
      ctx.out(`${renderDiagnostics(report)}\n`)
    })

  // M10/M11 — the `web` subcommand is registered by the web module; the
  // handler is wired here so the interactive/CLI entry point stays in one
  // place. The server keeps the event loop alive until Ctrl+C.
  const webCommand = registerWebCommand(program)
  webCommand.action(async (flags: WebCommandFlags) => {
    const options = webOptionsFromFlags(flags)
    const started = await startWebServer({
      repositoryRoot: options.repositoryRoot ?? ctx.repositoryRoot,
      homeRoot: ctx.homeRoot,
      registry: ctx.registry,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.open === undefined ? {} : { open: options.open }),
      out: ctx.out,
      err: ctx.err,
    })
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        void started.close().then(() => resolve())
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
  })

  return program
}
