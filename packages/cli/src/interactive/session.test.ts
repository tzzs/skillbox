import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AgentRegistry,
  Logger,
  defaultLogFilePath,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentDetectionResult,
  type AgentInstalledSkill,
  type AgentLinkOptions,
  type AgentUnlinkResult,
} from '@skillbox/core'
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
  /** Everything the session wrote to stderr. */
  errors(): string
}

/** Declares a local skill whose directory does not exist: one reconcile problem. */
const PROBLEM_MANIFEST = `version: 1
skills:
  ghost:
    source:
      type: local
      path: skills/ghost
`

/** Minimal detectable agent whose skill directory is a throwaway folder. */
class FakeAgentAdapter implements AgentAdapter {
  readonly name: string
  readonly capabilities: AgentCapabilities = {
    supportsGlobalSkills: true,
    supportsProjectSkills: true,
    supportsSymlinks: true,
    supportsNestedSkillDirectories: false,
    requiresRestartAfterChange: false,
  }

  constructor(
    readonly id: string,
    private readonly dir: string,
  ) {
    this.name = id
  }

  async detect(): Promise<AgentDetectionResult> {
    return { detected: true, skillDirectories: [this.dir], confidence: 'high' }
  }
  async getSkillDirectories(): Promise<string[]> {
    return [this.dir]
  }
  async scanSkills(): Promise<AgentInstalledSkill[]> {
    return []
  }
  async linkSkill(source: string, options?: AgentLinkOptions): Promise<void> {
    fs.mkdirSync(path.join(this.dir, options?.name ?? path.basename(source)), { recursive: true })
  }
  async unlinkSkill(name: string): Promise<AgentUnlinkResult> {
    fs.rmSync(path.join(this.dir, name), { recursive: true, force: true })
    return { name, path: path.join(this.dir, name), removed: true, reason: 'managed' }
  }
}

/** Builds a throwaway repo + home and a minimal manifest so reconcile works. */
function createHarness(
  answers: string[],
  options: { manifest?: string | false; withAgent?: boolean } = {},
): SessionHarness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skillbox-session-'))
  const repoRoot = path.join(base, 'repo')
  const homeRoot = path.join(base, 'home')
  const agentRoot = path.join(base, 'agent')
  fs.mkdirSync(repoRoot)
  fs.mkdirSync(homeRoot)
  fs.mkdirSync(agentRoot)
  if (options.manifest !== false) {
    fs.writeFileSync(
      path.join(repoRoot, 'skillbox.yaml'),
      options.manifest ?? 'version: 1\nskills: {}\n',
    )
  }
  const errorChunks: string[] = []
  const registry =
    options.withAgent === true
      ? new AgentRegistry([new FakeAgentAdapter('demo', agentRoot)])
      : new AgentRegistry()
  const ctx: CliContext = {
    repositoryRoot: repoRoot,
    homeRoot,
    registry,
    verbosity: 'normal',
    out: (): void => undefined,
    err: (chunk): void => {
      errorChunks.push(chunk)
    },
    logger: new Logger({ logFile: defaultLogFilePath(homeRoot) }),
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
      pollDeviceFlow: async () => ({ status: 'pending' as const }),
      disconnect: async () => undefined,
    },
    secretScanner: {
      isReady: async () => false,
      scanChangedFiles: async () => ({ findings: [], blocked: false }),
    },
  }
  const prompts = new FakePrompts(answers)
  return { ctx, prompts, errors: () => errorChunks.join('') }
}

function cleanup(harness: SessionHarness): void {
  const base = path.dirname(harness.ctx.repositoryRoot)
  fs.rmSync(base, { recursive: true, force: true })
}

/** Writes the first-run marker so the session skips onboarding. */
function markOnboarded(harness: SessionHarness): void {
  const marker = markerPathOf(harness)
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, '{"onboarded": true}\n')
}

function markerPathOf(harness: SessionHarness): string {
  return path.join(harness.ctx.homeRoot, 'state', FIRST_RUN_FILE_NAME)
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

  /**
   * A first run in a folder with no manifest has nothing to materialise, and
   * `install()` fails on it — so onboarding must not call it. Before the guard
   * this rejected with MANIFEST_NOT_FOUND, which killed the session before the
   * menu and before the first-run marker was written.
   */
  it('finishes onboarding when the repository has no manifest yet', async () => {
    const harness = createHarness(['exit'], { manifest: false })
    try {
      await new InteractiveSession({ ctx: harness.ctx, prompts: harness.prompts }).run()

      const all = harness.prompts.calls.join('\n')
      expect(all).toContain('note:Step 2 · Scan existing skills')
      expect(all).toContain('select:exit')
      expect(harness.prompts.calls.some((call) => call.startsWith('success:Synced'))).toBe(false)
      expect(fs.existsSync(markerPathOf(harness))).toBe(true)
    } finally {
      cleanup(harness)
    }
  })

  it('lists the reconcile problems the onboarding sync reports', async () => {
    const harness = createHarness(['exit'], { manifest: PROBLEM_MANIFEST })
    try {
      await new InteractiveSession({ ctx: harness.ctx, prompts: harness.prompts }).run()
      const all = harness.prompts.calls.join('\n')
      expect(all).toContain('success:Synced "')
      expect(harness.errors()).toContain('  SKILL_MISSING ghost: Local skill directory missing:')
    } finally {
      cleanup(harness)
    }
  })

  it('lists the reconcile problems an agent toggle reports', async () => {
    const harness = createHarness(
      ['my-skills', 'ghost', 'toggle', 'demo:enable', 'back', '__back__', 'exit'],
      { manifest: PROBLEM_MANIFEST, withAgent: true },
    )
    try {
      markOnboarded(harness)
      await new InteractiveSession({ ctx: harness.ctx, prompts: harness.prompts }).run()
      const all = harness.prompts.calls.join('\n')
      expect(all).toContain('success:Enabled "ghost" for demo.')
      expect(harness.errors()).toContain('  SKILL_MISSING ghost: Local skill directory missing:')
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
