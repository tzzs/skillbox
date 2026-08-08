import { Command } from 'commander'
import {
  createDefaultAgentRegistry,
  resolveSkillboxHome,
  type AgentDetectionSummary,
  type AgentRegistry,
  type ReconcileProblem,
  SkillService,
  StatusService,
  version,
} from '@skillbox/core'
import type { RepositoryStatus, SkillStatusEntry } from '@skillbox/core'
import { renderTable } from './table.js'

export interface CliDeps {
  /** Repository root; defaults to the current working directory. */
  repositoryRoot?: string
  /** Skillbox home root; defaults to `$HOME/.skillbox` (or `SKILLBOX_HOME`). */
  homeRoot?: string
  /** Agent registry; defaults to the built-in Claude + Codex adapters. */
  registry?: AgentRegistry
  stdout?: (chunk: string) => void
  stderr?: (chunk: string) => void
}

export interface CliContext {
  repositoryRoot: string
  homeRoot: string
  registry: AgentRegistry
  out: (chunk: string) => void
  err: (chunk: string) => void
}

export function buildContext(deps: CliDeps = {}): CliContext {
  return {
    repositoryRoot: deps.repositoryRoot ?? process.cwd(),
    homeRoot: deps.homeRoot ?? resolveSkillboxHome(),
    registry: deps.registry ?? createDefaultAgentRegistry(),
    out: deps.stdout ?? ((chunk) => process.stdout.write(chunk)),
    err: deps.stderr ?? ((chunk) => process.stderr.write(chunk)),
  }
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

  const program = new Command()
  program
    .name('skillbox')
    .description('Manage the skills your AI agents use.')
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
    .description('Install/restore the repository (reconcile skills and agent links)')
    .action(async () => {
      const report = await skills.install()
      ctx.out(`Reconciled "${report.repository}"\n`)
      ctx.out(
        `  skills   ${report.skills.length}\n  problems ${report.problems.length}\n  changed  ${report.changed ? 'yes' : 'no'}\n`,
      )
      reportProblems(ctx, report.problems)
    })

  program
    .command('status')
    .description('Show the full repository status (Repository, Skills, Agents)')
    .option('--json', 'emit JSON instead of human-readable sections')
    .action(async (options: { json?: boolean }) => {
      const report = await statusService.status()
      if (options.json === true) {
        printJson(ctx.out, report)
        return
      }
      ctx.out(`${statusOverview(report)}\n`)
      ctx.out(`\nSkills\n${skillTable(report.skills)}\n`)
      ctx.out(`\nAgents\n${agentTable(report.agents)}\n`)
      ctx.out(`\nModified skills\n${bulletList(report.modified)}`)
      ctx.out(`\nBroken skills\n${bulletList(report.broken)}\n`)
    })

  return program
}
