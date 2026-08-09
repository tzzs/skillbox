import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentRegistry } from '@skillbox/core'
import type { CliContext } from '../program.js'
import type { InteractivePrompt } from './prompts.js'
import { FIRST_RUN_FILE_NAME, InteractiveSession } from './session.js'
import type { StartedWebServer, WebServerOptions } from '../web/types.js'

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
    gitProvider: {
      status: async () => ({
        isRepository: false,
        ahead: 0,
        behind: 0,
        changedFiles: [],
        stagedFiles: [],
        conflicts: [],
      }),
      pull: async () => ({ conflicts: [], changedFiles: [] }),
      commit: async (message) => ({ committed: true, message }),
      push: async () => undefined,
    },
    githubProvider: {
      connectionState: async () => 'not-connected',
      startDeviceFlow: async () => ({
        userCode: 'ABCD-1234',
        verificationUri: 'https://example.com/device',
        intervalMs: 100,
        expiresInMs: 600000,
      }),
      pollDeviceFlow: async () => 'not-connected',
      disconnect: async () => undefined,
    },
    secretScanner: {
      isReady: async () => false,
      scanChangedFiles: async () => ({ findings: [], blocked: false }),
    },
  }
  const prompts = new FakePrompts(answers)
  return { ctx, prompts }
}

function cleanup(harness: SessionHarness): void {
  const base = path.dirname(harness.ctx.repositoryRoot)
  fs.rmSync(base, { recursive: true, force: true })
}

/** Writes the first-run marker so the session skips onboarding. */
function markOnboarded(harness: SessionHarness): void {
  const markerDir = path.join(harness.ctx.homeRoot, 'state')
  fs.mkdirSync(markerDir, { recursive: true })
  fs.writeFileSync(path.join(markerDir, FIRST_RUN_FILE_NAME), '{"onboarded": true}\n')
}

/** Polls until `predicate` becomes true (bounds the test instead of hanging). */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
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

  it('starts the web UI from the menu and stops it when the stop promise resolves', async () => {
    const harness = createHarness(['web', 'exit'])
    try {
      markOnboarded(harness)

      let startOptions: WebServerOptions | undefined
      let closeCount = 0
      const stop = { release: undefined as (() => void) | undefined }
      const started: StartedWebServer = {
        url: 'http://127.0.0.1:43999',
        port: 43999,
        server: {} as import('node:http').Server,
        close: async () => {
          closeCount += 1
        },
      }
      const startServer = async (options: WebServerOptions): Promise<StartedWebServer> => {
        startOptions = options
        return started
      }
      const waitForStop = (): Promise<void> =>
        new Promise<void>((resolve) => {
          stop.release = resolve
        })

      const session = new InteractiveSession({
        ctx: harness.ctx,
        prompts: harness.prompts,
        startWebServer: startServer,
        waitForStop,
      })

      const running = session.run()
      await waitUntil(() => startOptions !== undefined)
      expect(startOptions?.repositoryRoot).toBe(harness.ctx.repositoryRoot)
      expect(startOptions?.homeRoot).toBe(harness.ctx.homeRoot)
      expect(startOptions?.registry).toBe(harness.ctx.registry)

      stop.release?.()
      await running

      expect(closeCount).toBe(1)
      const all = harness.prompts.calls.join('\n')
      expect(all).toContain('select:web')
      expect(all).toContain('note:Web UI')
      expect(all).toContain('info:Web UI stopped.')
      expect(all).toContain('select:exit')
    } finally {
      cleanup(harness)
    }
  })

  it('reports a web UI start failure and returns to the menu', async () => {
    const harness = createHarness(['web', 'exit'])
    try {
      const startServer = async (): Promise<StartedWebServer> => {
        throw new Error('could not bind the web port')
      }
      const session = new InteractiveSession({
        ctx: harness.ctx,
        prompts: harness.prompts,
        startWebServer: startServer,
      })
      await session.run()
      const all = harness.prompts.calls.join('\n')
      expect(all).toContain('error:could not bind the web port')
      expect(all).toContain('select:exit')
    } finally {
      cleanup(harness)
    }
  })
})
