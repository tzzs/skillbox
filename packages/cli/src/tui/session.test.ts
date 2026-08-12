import { describe, expect, it } from 'vitest'
import type { SkillStatusEntry } from '@skillbox/core'
import { TuiSession, type TuiService, type TuiTerminal } from './session.js'
import type { TuiAgentSummary } from './view.js'

const skill: SkillStatusEntry = {
  name: 'review',
  mode: 'managed',
  status: 'ready',
  agents: [],
}
const agent: TuiAgentSummary = {
  id: 'claude',
  name: 'Claude Code',
  detected: true,
  skillCount: 0,
}

class FakeTerminal implements TuiTerminal {
  rendered: string[] = []
  entered = 0
  exited = 0
  constructor(
    private readonly keys: string[],
    private readonly answers: string[] = [],
  ) {}
  isInteractive(): boolean {
    return true
  }
  enter(): void {
    this.entered += 1
  }
  exit(): void {
    this.exited += 1
  }
  render(frame: string): void {
    this.rendered.push(frame)
  }
  async readKey(): Promise<string> {
    return this.keys.shift() ?? 'q'
  }
  async ask(): Promise<string> {
    return this.answers.shift() ?? ''
  }
  async confirm(): Promise<boolean> {
    return true
  }
}

function fakeService(): TuiService & { syncs: number; enabled: string[] } {
  return {
    syncs: 0,
    enabled: [],
    async overview() {
      return { skills: [skill], agents: [agent] }
    },
    async sync() {
      this.syncs += 1
      return { changed: true, skillCount: 1, problems: 0 }
    },
    async create() {
      return { name: 'new-skill' }
    },
    async enable(_name, agentId) {
      this.enabled.push(agentId)
    },
    async disable() {},
    async remove() {},
  }
}

describe('TuiSession', () => {
  it('uses the full-screen terminal and runs the core-backed sync workflow', async () => {
    const terminal = new FakeTerminal(['s', 'q'])
    const service = fakeService()
    await new TuiSession({ terminal, service }).run()

    expect(terminal.entered).toBe(1)
    expect(terminal.exited).toBe(1)
    expect(service.syncs).toBe(1)
    expect(terminal.rendered.some((frame) => frame.includes('Sync complete'))).toBe(true)
  })

  it('confirms and enables a selected skill for an agent', async () => {
    const terminal = new FakeTerminal(['enter', 'enter', 'e', 'q'], ['claude'])
    const service = fakeService()
    await new TuiSession({ terminal, service }).run()

    expect(service.enabled).toEqual(['claude'])
    expect(terminal.rendered.some((frame) => frame.includes('Enabled review for claude'))).toBe(
      true,
    )
  })
})
