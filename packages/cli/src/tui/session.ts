import * as readline from 'node:readline/promises'
import { SkillService, StatusService, type SkillStatusEntry } from '@skillbox/core'
import type { CliContext } from '../program.js'
import { renderFullscreen, type TuiAgentSummary, type TuiPage } from './view.js'

/** Terminal adapter. Keeping it narrow makes the full-screen flow testable without a real TTY. */
export interface TuiTerminal {
  isInteractive(): boolean
  enter(): void
  exit(): void
  render(frame: string): void
  readKey(): Promise<string>
  ask(message: string): Promise<string>
  confirm(message: string): Promise<boolean>
}

export interface TuiOverview {
  skills: readonly SkillStatusEntry[]
  agents: readonly TuiAgentSummary[]
}

/** Core-service facade used by the TUI; no lifecycle rules are duplicated in the renderer. */
export interface TuiService {
  overview(): Promise<TuiOverview>
  sync(): Promise<{ changed: boolean; skillCount: number; problems: number }>
  create(name: string, description?: string): Promise<{ name: string }>
  enable(name: string, agent: string): Promise<void>
  disable(name: string, agent: string): Promise<void>
  remove(name: string): Promise<void>
}

export function createTuiService(ctx: CliContext): TuiService {
  const skills = new SkillService({
    repositoryRoot: ctx.repositoryRoot,
    homeRoot: ctx.homeRoot,
    registry: ctx.registry,
  })
  const status = new StatusService({ repositoryRoot: ctx.repositoryRoot, registry: ctx.registry })
  return {
    async overview(): Promise<TuiOverview> {
      const report = await status.status()
      const agents = await ctx.registry.detectAll()
      return {
        skills: report.skills,
        agents: agents.map(({ id, name, detected, skillCount }) => ({
          id,
          name,
          detected,
          skillCount,
        })),
      }
    },
    async sync() {
      const report = await skills.install()
      return {
        changed: report.changed,
        skillCount: report.skills.length,
        problems: report.problems.length,
      }
    },
    async create(name: string, description?: string) {
      const result = await skills.createSkill(
        description === undefined ? { name } : { name, description },
      )
      return { name: result.name }
    },
    async enable(name: string, agent: string): Promise<void> {
      await skills.enableSkill({ name, agent })
    },
    async disable(name: string, agent: string): Promise<void> {
      await skills.disableSkill({ name, agent })
    },
    async remove(name: string): Promise<void> {
      await skills.removeSkill({ name })
    },
  }
}

export interface TuiSessionOptions {
  terminal: TuiTerminal
  service: TuiService
}

/**
 * Keyboard-first alternate-screen UI. Mutating commands share the exact Core
 * service façade as the one-shot CLI, while destructive actions require an
 * explicit, default-no confirmation through the terminal adapter.
 */
export class TuiSession {
  private page: TuiPage = 'overview'
  private selected = 0
  private notice: string | undefined
  private overview: TuiOverview = { skills: [], agents: [] }

  constructor(private readonly options: TuiSessionOptions) {}

  async run(): Promise<void> {
    this.options.terminal.enter()
    try {
      await this.refresh()
      let running = true
      while (running) {
        this.render()
        const key = (await this.options.terminal.readKey()).toLowerCase()
        running = await this.handle(key)
      }
    } finally {
      this.options.terminal.exit()
    }
  }

  private async refresh(): Promise<void> {
    this.overview = await this.options.service.overview()
    const max = this.currentItems() - 1
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, max)))
  }

  private currentItems(): number {
    return this.page === 'agents' ? this.overview.agents.length : this.overview.skills.length
  }

  private render(): void {
    const model = {
      ...this.overview,
      page: this.page,
      selected: this.selected,
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    }
    this.options.terminal.render(renderFullscreen(model))
    this.notice = undefined
  }

  private selectedSkill(): SkillStatusEntry | undefined {
    return this.overview.skills[this.selected]
  }

  private async handle(key: string): Promise<boolean> {
    if (key === 'q' || key === 'ctrl-c') return false
    if (key === 'down' || key === 'j') {
      this.selected = Math.min(Math.max(0, this.currentItems() - 1), this.selected + 1)
      return true
    }
    if (key === 'up' || key === 'k') {
      this.selected = Math.max(0, this.selected - 1)
      return true
    }
    if (key === 'escape') {
      this.page = this.page === 'detail' ? 'skills' : 'overview'
      this.selected = 0
      return true
    }
    if (key === 'a') {
      this.page = 'agents'
      this.selected = 0
      return true
    }
    if (key === 's') return this.sync()
    if (key === 'c') return this.create()
    if (key === 'enter') {
      if (this.page === 'overview') this.page = 'skills'
      else if (this.page === 'skills' && this.selectedSkill() !== undefined) this.page = 'detail'
      return true
    }
    if (this.page === 'detail' && key === 'e') return this.assign('enable')
    if (this.page === 'detail' && key === 'd') return this.assign('disable')
    if (this.page === 'detail' && key === 'x') return this.remove()
    return true
  }

  private async sync(): Promise<boolean> {
    return this.action(async () => {
      const result = await this.options.service.sync()
      return `Sync complete · ${result.skillCount} skills · ${result.problems} problems · ${result.changed ? 'changed' : 'unchanged'}`
    })
  }

  private async create(): Promise<boolean> {
    const name = (await this.options.terminal.ask('New skill name:')).trim()
    if (name.length === 0) {
      this.notice = 'Create cancelled.'
      return true
    }
    const description = (await this.options.terminal.ask('Description (optional):')).trim()
    return this.action(async () => {
      const result = await this.options.service.create(name, description || undefined)
      return `Created ${result.name}.`
    })
  }

  private async assign(kind: 'enable' | 'disable'): Promise<boolean> {
    const skill = this.selectedSkill()
    if (skill === undefined) return true
    const agent = (await this.options.terminal.ask(`Agent id to ${kind}:`)).trim()
    if (agent.length === 0) {
      this.notice = `${kind === 'enable' ? 'Enable' : 'Disable'} cancelled.`
      return true
    }
    if (
      !(await this.options.terminal.confirm(
        `${kind === 'enable' ? 'Enable' : 'Disable'} ${skill.name} for ${agent}?`,
      ))
    ) {
      this.notice = 'No changes made.'
      return true
    }
    return this.action(async () => {
      await this.options.service[kind](skill.name, agent)
      return `${kind === 'enable' ? 'Enabled' : 'Disabled'} ${skill.name} for ${agent}.`
    })
  }

  private async remove(): Promise<boolean> {
    const skill = this.selectedSkill()
    if (skill === undefined) return true
    if (!(await this.options.terminal.confirm(`Remove ${skill.name} from Skillbox?`))) {
      this.notice = 'No changes made.'
      return true
    }
    return this.action(async () => {
      await this.options.service.remove(skill.name)
      this.page = 'skills'
      return `Removed ${skill.name}. Repository files were kept.`
    })
  }

  private async action(run: () => Promise<string>): Promise<boolean> {
    try {
      this.notice = await run()
      await this.refresh()
    } catch (error) {
      this.notice = error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`
    }
    return true
  }
}

/** Native ANSI terminal implementation. No additional runtime dependency is needed. */
export class NativeTuiTerminal implements TuiTerminal {
  isInteractive(): boolean {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY && !process.env.CI)
  }
  enter(): void {
    process.stdout.write('\u001B[?1049h\u001B[?25l')
  }
  exit(): void {
    process.stdout.write('\u001B[?25h\u001B[?1049l')
  }
  render(frame: string): void {
    process.stdout.write(`\u001B[2J\u001B[H${frame}\n`)
  }
  readKey(): Promise<string> {
    return new Promise((resolve) => {
      const input = process.stdin
      input.setRawMode?.(true)
      input.resume()
      input.once('data', (buffer: Buffer) => {
        input.setRawMode?.(false)
        const value = buffer.toString('utf8')
        if (value === '\u0003') resolve('ctrl-c')
        else if (value === '\u001B[A') resolve('up')
        else if (value === '\u001B[B') resolve('down')
        else if (value === '\r' || value === '\n') resolve('enter')
        else if (value === '\u001B') resolve('escape')
        else resolve(value)
      })
    })
  }
  async ask(message: string): Promise<string> {
    process.stdout.write(`\u001B[?25h\n${message} `)
    const input = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await input.question('')
    } finally {
      input.close()
      process.stdout.write('\u001B[?25l')
    }
  }
  async confirm(message: string): Promise<boolean> {
    const answer = (await this.ask(`${message} [y/N]`)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }
}
