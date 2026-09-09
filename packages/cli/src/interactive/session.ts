import { spawn } from 'node:child_process'
import * as path from 'node:path'
import {
  FilesystemService,
  isSkillboxError,
  RuntimeConfigService,
  withRuntimeLock,
  SkillboxHome,
  SkillService,
  StatusService,
  validateSkillAlias,
  type AgentDetectionSummary,
  type ImportResult,
  type SkillStatusEntry,
} from '@skillbox/core'
import type { CliContext } from '../program.js'
import type { InteractivePrompt } from './prompts.js'
import { isCancelResult } from './prompts.js'
import {
  agentStatusLines,
  buildSkillDetailLines,
  buildWelcomeSection,
  skillStatusLabel,
  toSkillDetail,
  type SkillDetailModel,
} from './format.js'
import {
  buildAgentToggleOptions,
  buildMainMenuItems,
  buildSkillDetailActions,
  parseToggleValue,
  withBackOption,
  type MenuOption,
} from './menu.js'
import {
  buildImportCandidates,
  buildImportPlan,
  conflictResolutionOptions,
  decodeConflictSelection,
  type AgentScanned,
  type ImportPlanItem,
} from './import-plan.js'
import { resolveEditorCommand } from './editor.js'
import { startWebServer, type StartedWebServer, type WebServerOptions } from '@skillbox/web-server'

export const FIRST_RUN_FILE_NAME = 'first-run.json'

export interface InteractiveSessionOptions {
  ctx: CliContext
  prompts: InteractivePrompt
  /**
   * Starter used by the "Open Web UI" menu action; defaults to the real
   * `startWebServer` (with its EADDRINUSE fallback) from the web module.
   */
  startWebServer?: (options: WebServerOptions) => Promise<StartedWebServer>
  /** Resolves when a running Web UI server should stop; defaults to Ctrl+C/SIGTERM. */
  waitForStop?: () => Promise<void>
}

/** Resolves the first time the process receives SIGINT (Ctrl+C) or SIGTERM. */
function waitForStopOnSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

/**
 * The M9 interactive flow. Knows only how to *ask questions* and *render
 * answers*; every mutation is delegated to Core services (SkillService,
 * StatusService, RuntimeConfigService). No business logic lives here.
 */
export class InteractiveSession {
  private readonly ctx: CliContext
  private readonly prompts: InteractivePrompt
  private readonly filesystem: FilesystemService
  private readonly skills: SkillService
  private readonly statusService: StatusService
  private readonly home: SkillboxHome
  private readonly config: RuntimeConfigService
  private readonly startWebServerFn: (options: WebServerOptions) => Promise<StartedWebServer>
  private readonly waitForStopFn: () => Promise<void>
  private readonly agentDisplayNames = new Map<string, string>()

  constructor(options: InteractiveSessionOptions) {
    this.ctx = options.ctx
    this.prompts = options.prompts
    this.filesystem = new FilesystemService()
    this.skills = new SkillService({
      repositoryRoot: options.ctx.repositoryRoot,
      homeRoot: options.ctx.homeRoot,
      registry: options.ctx.registry,
    })
    this.statusService = new StatusService({
      repositoryRoot: options.ctx.repositoryRoot,
      registry: options.ctx.registry,
    })
    this.home = new SkillboxHome({ root: options.ctx.homeRoot })
    this.config = new RuntimeConfigService({ configFilePath: this.home.configFilePath() })
    this.startWebServerFn = options.startWebServer ?? startWebServer
    this.waitForStopFn = options.waitForStop ?? waitForStopOnSignal
    for (const adapter of options.ctx.registry.list()) {
      this.agentDisplayNames.set(adapter.id, adapter.name)
    }
  }

  private get markerPath(): string {
    return path.join(this.home.directory('state'), FIRST_RUN_FILE_NAME)
  }

  private agentLabel(id: string): string {
    return this.agentDisplayNames.get(id) ?? id
  }

  async run(): Promise<void> {
    await this.home.ensure()
    this.prompts.intro('Skillbox')
    const detected = await this.ctx.registry.detectAll()
    const report = await this.statusService.status()

    const welcome = buildWelcomeSection(detected, report.skills.length)
    this.prompts.note(welcome.lines.join('\n'), welcome.title)

    if (await this.isFirstRun()) {
      await this.onboarding(detected)
    }

    await this.menuLoop()
    this.prompts.outro('Thanks for using Skillbox.')
  }

  /* ------------------------------------------------------------------ */
  /* First-run onboarding (M9.4)                                        */
  /* ------------------------------------------------------------------ */

  /** Runs a mutating interactive operation under the cross-process mutation
   *  lock (roadmap 5.1), mirroring the CLI commands' audit logging. */
  private async withMutation<T>(operation: string, action: () => Promise<T>): Promise<T> {
    return withRuntimeLock(
      'mutation',
      async () => {
        try {
          const result = await action()
          this.ctx.logger.info(`mutation:${operation}:done`)
          return result
        } catch (error) {
          this.ctx.logger.warn(`mutation:${operation}:failed`, {
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      },
      { homeRoot: this.ctx.homeRoot },
    )
  }

  private async isFirstRun(): Promise<boolean> {
    return !(await this.filesystem.exists(this.markerPath))
  }

  private async markOnboarded(): Promise<void> {
    const serialized = JSON.stringify({ onboarded: true }, null, 2)
    await this.filesystem.writeFile(this.markerPath, `${serialized}\n`)
  }

  private async onboarding(detected: AgentDetectionSummary[]): Promise<void> {
    this.prompts.info('Welcome! You are starting fresh - a few quick steps to get you set up.')

    this.prompts.note(agentStatusLines(detected).join('\n'), 'Step 1 · Detect agents')

    const scans = await this.scanAgents()
    const manifestSkills = await this.manifestSkillNames()
    const candidates = buildImportCandidates(scans, manifestSkills)
    this.prompts.note(
      `Found ${candidates.length} unmanaged external skill${candidates.length === 1 ? '' : 's'}.`,
      'Step 2 · Scan existing skills',
    )

    if (candidates.length > 0) {
      const proceed = await this.prompts.confirm({
        message: 'Import them so Skillbox can manage everything?',
        active: 'Import',
        inactive: 'Skip',
        initialValue: true,
      })
      if (proceed === true) {
        await this.importSkills()
      } else {
        this.prompts.info('Skipped the import - you can import from the menu later.')
      }
    }

    await this.syncNow()

    this.prompts.note(
      [
        'GitHub Connect is planned for a later release (0.2+).',
        'For now everything stays local on your machine - nothing to install.',
      ].join('\n'),
      'Step 3 · Connect GitHub (skip for now)',
    )

    await this.markOnboarded()
  }

  private async syncNow(): Promise<void> {
    const result = await this.withMutation('sync', () => this.skills.install())
    const state = result.changed ? 'changed' : 'unchanged'
    this.prompts.success(
      `Synced "${result.repository}" (${result.skills.length} skills, ${result.problems.length} problems, ${state}).`,
    )
  }

  /* ------------------------------------------------------------------ */
  /* Main menu loop (M9)                                                 */
  /* ------------------------------------------------------------------ */

  private async menuLoop(): Promise<void> {
    for (;;) {
      const report = await this.statusService.status()
      const detected = await this.ctx.registry.detectAll()
      const choice = await this.prompts.select({
        message: 'What would you like to do?',
        options: buildMainMenuItems(report.skills.length, detected.length),
      })
      if (isCancelResult(choice) || choice === 'exit') {
        return
      }
      switch (choice) {
        case 'my-skills':
          await this.mySkills()
          break
        case 'agents':
          await this.agentsView()
          break
        case 'import':
          await this.importSkills()
          break
        case 'create':
          await this.createSkillFlow()
          break
        case 'web':
          await this.openWebUi()
          break
        case 'settings':
          await this.settingsFlow()
          break
        default:
          break
      }
    }
  }

  private async mySkills(): Promise<void> {
    const report = await this.statusService.status()
    if (report.skills.length === 0) {
      this.prompts.info('No managed skills yet - use "Create Skill" to scaffold your first one.')
      return
    }
    for (;;) {
      const options: MenuOption[] = report.skills.map((skill) => {
        const option: MenuOption = {
          value: skill.name,
          label: `${skill.name}  (${skillStatusLabel(skill.status)})`,
        }
        if (skill.message !== undefined) {
          option.hint = skill.message
        }
        return option
      })
      const choice = await this.prompts.select({
        message: 'Select a skill:',
        options: withBackOption(options),
      })
      if (isCancelResult(choice) || choice === '__back__') {
        return
      }
      const entry = report.skills.find((skill) => skill.name === choice)
      if (entry !== undefined) {
        await this.skillDetail(entry)
      }
    }
  }

  private async agentsView(): Promise<void> {
    const detected = await this.ctx.registry.detectAll()
    this.prompts.note(agentStatusLines(detected).join('\n'), 'Detected agents')
  }

  /* ------------------------------------------------------------------ */
  /* Create a skill (M-8 CLI, interactive flavor)                       */
  /* ------------------------------------------------------------------ */

  private async createSkillFlow(): Promise<void> {
    const name = await this.prompts.text({
      message: 'Skill name (lowercase alias, e.g. my-review-skill)',
      placeholder: 'my-review-skill',
      validate: (value) => {
        try {
          const trimmed = value.trim()
          if (trimmed.length === 0) {
            return 'A name is required'
          }
          validateSkillAlias(trimmed)
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    })
    if (isCancelResult(name)) {
      return
    }
    if (name.trim().length === 0) {
      return
    }

    const description = await this.prompts.text({
      message: 'Short description (optional)',
      initialValue: '',
    })
    let desc: string | undefined
    if (!isCancelResult(description) && description.trim().length > 0) {
      desc = description.trim()
    }

    try {
      const input: { name: string; description?: string } = { name: name.trim() }
      if (desc !== undefined) {
        input.description = desc
      }
      const created = await this.withMutation('create', () => this.skills.createSkill(input))
      this.prompts.success(`Created skill "${created.name}"`)
      this.prompts.info(`  repo:    ${created.path}`)
      this.prompts.info(`  library: ${created.materialized.path}`)
    } catch (error) {
      this.handleError(error)
    }
  }

  /* ------------------------------------------------------------------ */
  /* Import Existing Skills (M-9.5/Import UI)                            */
  /* ------------------------------------------------------------------ */

  private async scanAgents(): Promise<AgentScanned[]> {
    const scanned: AgentScanned[] = []
    for (const adapter of this.ctx.registry.list()) {
      let detected = false
      try {
        detected = (await adapter.detect()).detected
      } catch {
        detected = false
      }
      let installed: Awaited<ReturnType<typeof adapter.scanSkills>> = []
      try {
        installed = await adapter.scanSkills()
      } catch {
        installed = []
      }
      scanned.push({
        agentId: adapter.id,
        agentName: adapter.name,
        detected,
        installed,
      })
    }
    return scanned
  }

  private async manifestSkillNames(): Promise<string[]> {
    const report = await this.statusService.status()
    return report.skills.map((skill) => skill.name)
  }

  private async importSkills(): Promise<void> {
    const manifestSkills = await this.manifestSkillNames()
    const scans = await this.scanAgents()
    const candidates = buildImportCandidates(scans, manifestSkills)
    if (candidates.length === 0) {
      this.prompts.info('No unmanaged external skills found - nothing to import.')
      return
    }
    this.prompts.note(
      `${candidates.length} unmanaged external skill${candidates.length === 1 ? '' : 's'} found.`,
      'Import Existing Skills',
    )
    const options = candidates.map((candidate) => ({
      value: candidate.name,
      label: `${candidate.name}${candidate.alreadyManaged ? ' (already imported)' : ''}`,
      hint: `${candidate.presentAgents.length} agent${candidate.presentAgents.length === 1 ? '' : 's'}`,
    }))
    const choices = await this.prompts.multiselect({
      message: 'Select the skills to import:',
      options,
    })
    if (isCancelResult(choices)) {
      return
    }
    if (choices.length === 0) {
      this.prompts.warn('Nothing selected - no changes were made.')
      return
    }

    const plan = buildImportPlan(candidates, choices)
    const outcomes = await this.withMutation('import', async () => {
      const results: Array<'imported' | 'conflict' | 'none'> = []
      for (const item of plan) {
        results.push(await this.importOne(item))
      }
      return results
    })
    let imported = 0
    let conflictsReset = 0
    for (const outcome of outcomes) {
      if (outcome === 'imported') {
        imported += 1
      } else if (outcome === 'conflict') {
        conflictsReset += 1
      }
    }
    if (imported > 0) {
      this.prompts.success(`Imported ${imported} skill${imported === 1 ? '' : 's'}.`)
    }
    if (conflictsReset > 0) {
      this.prompts.warn(
        `${conflictsReset} conflict${conflictsReset === 1 ? '' : 's'} were skipped or resolved.`,
      )
    }
  }

  private async importOne(item: ImportPlanItem): Promise<'imported' | 'conflict' | 'none'> {
    const run = async (
      decision?: import('@skillbox/core').ImportDecision,
    ): Promise<ImportResult> => {
      const input: {
        name: string
        sourceDir: string
        migrateAgents?: string[]
        decision?: import('@skillbox/core').ImportDecision
      } = {
        name: item.alias,
        sourceDir: item.sourceDir,
      }
      if (item.migrateAgents.length > 0) {
        input.migrateAgents = item.migrateAgents
      }
      if (decision !== undefined) {
        input.decision = decision
      }
      return this.skills.importExistingSkill(input)
    }

    let result: ImportResult
    try {
      result = await run()
    } catch (error) {
      this.handleError(error)
      return 'none'
    }

    if (result.status === 'conflict') {
      const conflict = result.conflicts?.[0]
      if (conflict === undefined) {
        this.prompts.error(`Import of "${item.alias}" failed with an unknown conflict.`)
        return 'conflict'
      }
      this.prompts.warn(
        `"${conflict.alias}" already exists with the same or different content in this repository.`,
      )
      const choice = await this.prompts.select({
        message: 'How should Skillbox resolve this?',
        options: conflictResolutionOptions(conflict),
      })
      if (isCancelResult(choice)) {
        return 'conflict'
      }
      try {
        const retried = await run(decodeConflictSelection(choice, conflict.alias))
        this.reportUnresolved(retried)
        return retried.status === 'imported' ? 'imported' : 'conflict'
      } catch (error) {
        this.handleError(error)
        return 'conflict'
      }
    }
    return this.reportUnresolved(result)
  }

  private reportUnresolved(result: ImportResult): 'imported' | 'conflict' | 'none' {
    const alias = result.alias ?? 'skill'
    switch (result.status) {
      case 'imported':
        this.prompts.success(`Imported "${alias}".`)
        return 'imported'
      case 'kept-existing':
        this.prompts.info(`Kept the existing "${alias}".`)
        return 'none'
      case 'unchanged':
        this.prompts.info(`"${alias}" was already up to date.`)
        return 'none'
      case 'skipped':
        this.prompts.warn(`Skipped "${alias}".`)
        return 'none'
      case 'conflict':
        return 'conflict'
      default:
        return 'none'
    }
  }

  /* ------------------------------------------------------------------ */
  /* Skill detail view (M-9)                                             */
  /* ------------------------------------------------------------------ */

  private async skillDetail(entry: SkillStatusEntry): Promise<void> {
    let detail = toSkillDetail(entry)
    for (;;) {
      this.prompts.note(
        buildSkillDetailLines(detail, (id) => this.agentLabel(id)).join('\n'),
        `Skill: ${detail.name}`,
      )
      const action = await this.prompts.select({
        message: 'Actions',
        options: buildSkillDetailActions(detail.agents.length),
      })
      if (isCancelResult(action) || action === 'back') {
        return
      }
      switch (action) {
        case 'edit':
          await this.editSkill(detail)
          break
        case 'toggle': {
          const refreshed = await this.toggleAgents(detail)
          if (refreshed === true) {
            const latest = await this.latestSkill(detail.name)
            if (latest !== null) {
              detail = toSkillDetail(latest)
            }
          }
          break
        }
        case 'remove': {
          const removed = await this.removeSkill(detail)
          if (removed) {
            return
          }
          break
        }
        default:
          break
      }
    }
  }

  private async latestSkill(name: string): Promise<SkillStatusEntry | null> {
    const report = await this.statusService.status()
    return report.skills.find((skill) => skill.name === name) ?? null
  }

  private async editSkill(detail: SkillDetailModel): Promise<void> {
    if (detail.path === undefined) {
      this.prompts.warn(`"${detail.name}" has no local directory to edit.`)
      return
    }
    const filePath = path.join(detail.path, 'SKILL.md')
    const command = resolveEditorCommand(filePath, process.env)
    if (command === null) {
      this.prompts.info(`Edit the skill in your editor:\n  ${filePath}`)
      return
    }
    this.prompts.info(`Opening "${filePath}" with ${command.command}...`)
    const child = spawn(command.command, command.args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('error', (error) => {
      this.prompts.error(`Failed to open the editor: ${error.message}`)
    })
  }

  private async toggleAgents(detail: SkillDetailModel): Promise<boolean> {
    const adapters = this.ctx.registry.list().map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
    }))
    const options = buildAgentToggleOptions(adapters, detail.agents)
    const choice = await this.prompts.select({
      message: `Toggle agents for "${detail.name}"`,
      options,
    })
    if (isCancelResult(choice)) {
      return false
    }
    const parsed = parseToggleValue(choice)
    if (parsed === null) {
      return false
    }
    try {
      if (parsed.action === 'enable') {
        await this.skills.enableSkill({ name: detail.name, agent: parsed.agent })
        this.prompts.success(`Enabled "${detail.name}" for ${this.agentLabel(parsed.agent)}.`)
      } else {
        await this.skills.disableSkill({ name: detail.name, agent: parsed.agent })
        this.prompts.success(`Disabled "${detail.name}" for ${this.agentLabel(parsed.agent)}.`)
      }
      return true
    } catch (error) {
      this.handleError(error)
      return false
    }
  }

  private async removeSkill(detail: SkillDetailModel): Promise<boolean> {
    const confirmed = await this.prompts.confirm({
      message: `Remove "${detail.name}" from your library?`,
      initialValue: false,
      active: 'Yes, remove',
      inactive: 'Cancel',
    })
    if (confirmed !== true) {
      this.prompts.warn('Removal canceled.')
      return false
    }
    try {
      const result = await this.skills.removeSkill({ name: detail.name })
      this.prompts.success(
        `Removed "${result.name}"${result.filesRemoved ? ' (and its files)' : ' (files kept)'}.`,
      )
      return true
    } catch (error) {
      this.handleError(error)
      return false
    }
  }

  /* ------------------------------------------------------------------ */
  /* Web UI (M10/M11) + Settings (basic)                                */
  /* ------------------------------------------------------------------ */

  /**
   * M10/M11 — starts the local Web UI with the shared `startWebServer`
   * (EADDRINUSE fallback and URL printing included). The server keeps
   * running until the user presses Ctrl+C (or SIGTERM), then closes and
   * control returns to the main menu loop.
   */
  private async openWebUi(): Promise<void> {
    try {
      const started = await this.startWebServerFn({
        repositoryRoot: this.ctx.repositoryRoot,
        homeRoot: this.ctx.homeRoot,
        registry: this.ctx.registry,
        out: (chunk) => this.ctx.out(chunk),
        err: (chunk) => this.ctx.err(chunk),
      })
      this.prompts.note(
        `The web UI is running at ${started.url}.\nPress Ctrl+C to stop the server and return to the menu.`,
        'Web UI',
      )
      await this.waitForStopFn()
      await started.close()
      this.prompts.info('Web UI stopped.')
    } catch (error) {
      this.handleError(error)
    }
  }

  private async settingsFlow(): Promise<void> {
    const config = await this.config.load()
    this.prompts.note(
      [
        `Repository    ${config.repository ?? '(not set yet)'}`,
        `Link strategy ${config.linkStrategy ?? 'auto'}`,
        `Skillbox home ${this.home.root}`,
      ].join('\n'),
      'Settings',
    )
    const choice = await this.prompts.select({
      message: 'Settings',
      options: [
        {
          value: 'strategy',
          label: 'Set link strategy',
          hint: 'how skills are linked into agents',
        },
        { value: 'back', label: 'Back' },
      ],
    })
    if (isCancelResult(choice) || choice === 'back') {
      return
    }
    const strategy = await this.prompts.select({
      message: 'Link strategy',
      options: [
        { value: 'auto', label: 'auto', hint: 'symlink on macOS/Linux · junction on Windows' },
        { value: 'symlink', label: 'symlink' },
        { value: 'junction', label: 'junction' },
        { value: 'copy', label: 'copy', hint: 'most compatible, uses more space' },
      ],
    })
    if (isCancelResult(strategy)) {
      return
    }
    const LINK_STRATEGIES = ['auto', 'symlink', 'junction', 'copy'] as const
    if (!LINK_STRATEGIES.includes(strategy as (typeof LINK_STRATEGIES)[number])) {
      this.prompts.warn(`Unknown link strategy "${strategy}" - no change made.`)
      return
    }
    await this.config.update({ linkStrategy: strategy as (typeof LINK_STRATEGIES)[number] })
    this.prompts.success(`Link strategy set to "${strategy}".`)
  }

  private handleError(error: unknown): void {
    if (isSkillboxError(error)) {
      this.prompts.error(`${error.code}: ${error.message}`)
      return
    }
    this.prompts.error(error instanceof Error ? error.message : String(error))
  }
}
