import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentRegistry } from '@skillbox/core'
import type { CliContext } from '../program.js'
import type { InteractivePrompt } from './prompts.js'
import { InteractiveSession } from './session.js'

class FakePrompts implements InteractivePrompt {
  calls: string[] = []
  private readonly selectQueue: string[]

  constructor(selectAnswers: string[] = []) {
    this.selectQueue = [...selectAnswers]
  }

  intro(title?: string): void {
    this.calls.push(`intro:${title ?? ''}`)
  }
  outro(message?: string): void {
    this.calls.push(`outro:${message ?? ''}`)
  }
  note(message: string, title?: string): void {
    this.calls.push(`note:${title ?? ''}`)
    void message
  }
  info(message: string): void {
    this.calls.push(`info:${message}`)
  }
  success(message: string): void {
    this.calls.push(`success:${message}`)
  }
  warn(message: string): void {
    this.calls.push(`warn:${message}`)
  }
  error(message: string): void {
    this.calls.push(`error:${message}`)
  }
  async select(): Promise<string | symbol> {
    const value = this.selectQueue.shift() ?? 'exit'
    this.calls.push(`select:${value}`)
    return value
  }
  async multiselect(): Promise<string[]> {
    this.calls.push('multiselect:[]')
    return []
  }
  async confirm(): Promise<boolean> {
    this.calls.push('confirm:false')
    return false
  }
  async text(): Promise<string> {
    return ''
  }
}

interface SessionHarness {
  ctx: CliContext
  prompts: FakePrompts
}

/** Builds a throwaway repo + home and a minimal manifest so reconcile works. */
function createHarness(answers: string[]): SessionHarness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skillbox-session-'))
  const repoRoot = path.join(base, 'repo')
  const homeRoot = path.join(base, 'home')
  fs.mkdirSync(repoRoot)
  fs.mkdirSync(homeRoot)
  fs.writeFileSync(path.join(repoRoot, 'skillbox.yaml'), 'version: 1\nskills: {}\n')
  const ctx: CliContext = {
    repositoryRoot: repoRoot,
    homeRoot,
    registry: new AgentRegistry(),
    out: (): void => undefined,
    err: (): void => undefined,
  }
  const prompts = new FakePrompts(answers)
  return { ctx, prompts }
}

function cleanup(harness: SessionHarness): void {
  const base = path.dirname(harness.ctx.repositoryRoot)
  fs.rmSync(base, { recursive: true, force: true })
}

describe('InteractiveSession', () => {
  it('walks the first-run onboarding and quits from the main menu', async () => {
    const harness = createHarness(['exit'])
    try {
      await new InteractiveSession({ ctx: harness.ctx, prompts: harness.prompts }).run()
      const all = harness.prompts.calls.join('\n')
      expect(all).toContain('intro:')
      expect(all).toContain('note:Step 1 · Detect agents')
      expect(all).toContain('note:Step 2 · Scan existing skills')
      expect(all).toContain('select:exit')
    } finally {
      cleanup(harness)
    }
  })

  it('does not re-run the onboarding once the first-run marker exists', async () => {
    const harness = createHarness(['exit'])
    try {
      await new InteractiveSession({ ctx: harness.ctx, prompts: harness.prompts }).run()

      const second = new FakePrompts(['exit'])
      await new InteractiveSession({ ctx: harness.ctx, prompts: second }).run()

      const all = second.calls.join('\n')
      expect(all).not.toContain('note:Step 1 · Detect agents')
      expect(all).not.toContain('note:Step 2 · Scan existing skills')
      expect(all).toContain('select:exit')
    } finally {
      cleanup(harness)
    }
  })
})
