import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AgentRegistry,
  ErrorCode,
  isSkillboxError,
  MemoryCredentialStore,
  SkillboxError,
  type ReconcileResult,
  type SkillService,
} from '@skillbox/core'
import {
  SyncService,
  createDefaultGitHubProvider,
  createDefaultSecretScanner,
  createGitHubProviderFromCore,
  createGitProviderFromCore,
  createSecretScannerFromCore,
  type DeviceFlowStart,
  type GitHubProvider,
  type GitCommitOutcome,
  type GitProvider,
  type GitPullOutcome,
  type GitStatusReport,
  type GithubConnectionState,
  type SecretScanResult,
  type SecretScanner,
} from './index.js'

const REPO = 'C:\\repo'

function reconcileResult(root: string): ReconcileResult {
  return {
    changed: false,
    repository: root,
    linkStrategy: 'symlink',
    skills: [],
    staleLinks: [],
    agents: [],
    problems: [],
  }
}

class FakeGitProvider implements GitProvider {
  statusResult: GitStatusReport = {
    isRepository: true,
    ahead: 0,
    behind: 1,
    remote: { name: 'origin', url: 'https://github.com/u/repo.git' },
    changedFiles: ['skills/foo/SKILL.md', 'skillbox.lock'],
    stagedFiles: [],
    conflicts: [],
  }
  pullResult: GitPullOutcome = { conflicts: [], changedFiles: ['skills/foo/SKILL.md'] }
  commitOutcome: GitCommitOutcome = {
    committed: true,
    message: 'skillbox: sync 2 skill changes',
    shortHash: 'abc1234',
  }
  commits: Array<{ message: string; paths: string[] }> = []
  pushCalls = 0

  async status(): Promise<GitStatusReport> {
    return this.statusResult
  }
  async pull(): Promise<GitPullOutcome> {
    return this.pullResult
  }
  async commit(message: string, paths: readonly string[]): Promise<GitCommitOutcome> {
    this.commits.push({ message, paths: [...paths] })
    return this.commitOutcome
  }
  async push(): Promise<void> {
    this.pushCalls += 1
  }
}

class FakeGitHubProvider implements GitHubProvider {
  state: GithubConnectionState = 'connected'
  pollQueue: GithubConnectionState[] = []
  started = 0
  disconnected = 0
  readonly start: DeviceFlowStart = {
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://github.com/login/device',
    intervalMs: 0,
    expiresInMs: 10_000,
  }

  async connectionState(): Promise<GithubConnectionState> {
    return this.state
  }
  async startDeviceFlow(): Promise<DeviceFlowStart> {
    this.started += 1
    return this.start
  }
  async pollDeviceFlow(): Promise<GithubConnectionState> {
    const next = this.pollQueue.shift()
    if (next !== undefined) {
      this.state = next
    }
    return this.state
  }
  async disconnect(): Promise<void> {
    this.disconnected += 1
  }
}

class FakeSecretScanner implements SecretScanner {
  ready = true
  result: SecretScanResult = { findings: [], blocked: false }
  scanned: string[][] = []

  async isReady(): Promise<boolean> {
    return this.ready
  }
  async scanChangedFiles(paths: readonly string[]): Promise<SecretScanResult> {
    this.scanned.push([...paths])
    return this.result
  }
}

interface Harness {
  sync: SyncService
  git: FakeGitProvider
  github: FakeGitHubProvider
  secrets: FakeSecretScanner
  out(): string
}

function harness(): Harness {
  const chunks: string[] = []
  const git = new FakeGitProvider()
  const github = new FakeGitHubProvider()
  const secrets = new FakeSecretScanner()
  const skills = { install: async () => reconcileResult(REPO) } as unknown as SkillService
  const sync = new SyncService({
    repositoryRoot: REPO,
    registry: new AgentRegistry(),
    gitProvider: git,
    githubProvider: github,
    secretScanner: secrets,
    skills,
    out: (chunk) => chunks.push(chunk),
    sleep: async () => undefined,
  })
  return { sync, git, github, secrets, out: () => chunks.join('') }
}

describe('SyncService.sync', () => {
  it('runs the full pipeline and pushes a skillbox-owned commit', async () => {
    const h = harness()
    const result = await h.sync.sync()

    expect(result.steps.map((step) => step.step)).toEqual([
      'scan',
      'detect',
      'secret-scan',
      'pull',
      'resolve',
      'commit',
      'push',
    ])
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.commitMessage).toBe('skillbox: sync 2 skill changes')
    expect(h.git.pushCalls).toBe(1)
    expect(h.secrets.scanned[0]).toEqual(['skills/foo/SKILL.md', 'skillbox.lock'])
    expect(h.git.commits[0]?.paths).toContain('skillbox.yaml')
    expect(h.git.commits[0]?.paths).toContain('skillbox.lock')
  })

  it('skips the secret scan when the engine is not wired', async () => {
    const h = harness()
    h.secrets.ready = false
    const result = await h.sync.sync()
    expect(result.steps.find((step) => step.step === 'secret-scan')?.status).toBe('skipped')
  })

  it('skips the commit when there are no skillbox changes', async () => {
    const h = harness()
    h.git.statusResult.changedFiles = ['README.md']
    h.git.commitOutcome = { committed: false, message: 'chore(skillbox): sync skills' }
    const result = await h.sync.sync()
    expect(result.committed).toBe(false)
    expect(result.steps.find((step) => step.step === 'commit')?.status).toBe('skipped')
  })

  it('aborts on a merge conflict without overwriting', async () => {
    const h = harness()
    h.git.pullResult = { conflicts: ['skillbox.lock'], changedFiles: [] }
    const error = await h.sync.sync().catch((e: unknown) => e)
    expect(isSkillboxError(error)).toBe(true)
    expect(error).toMatchObject({ code: ErrorCode.GIT_CONFLICT })
    expect(h.git.pushCalls).toBe(0)
  })

  it('blocks the pipeline on critical/high secret findings', async () => {
    const h = harness()
    h.secrets.result = {
      blocked: true,
      findings: [
        {
          path: 'skills/foo/.env',
          rule: 'env-file',
          severity: 'high',
          message: 'environment file',
        },
      ],
    }
    const error = await h.sync.sync().catch((e: unknown) => e)
    expect(isSkillboxError(error)).toBe(true)
    expect(error).toMatchObject({ code: ErrorCode.SECRET_FOUND })
    expect(h.git.pushCalls).toBe(0)
  })

  it('refuses to push when the GitHub account is not connected', async () => {
    const h = harness()
    h.github.state = 'not-connected'
    const error = await h.sync.sync().catch((e: unknown) => e)
    expect(isSkillboxError(error)).toBe(true)
    expect(error).toMatchObject({ code: ErrorCode.GITHUB_NOT_CONNECTED })
    expect(h.git.pushCalls).toBe(0)
  })

  it('fails with GIT_NOT_INITIALIZED outside a git working tree', async () => {
    const h = harness()
    h.git.statusResult = {
      isRepository: false,
      ahead: 0,
      behind: 0,
      changedFiles: [],
      stagedFiles: [],
      conflicts: [],
    }
    const error = await h.sync.sync().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: ErrorCode.GIT_NOT_INITIALIZED })
  })

  it('reports a manifestless repository with an actionable hint', async () => {
    const h = harness()
    const skills = {
      install: async () => {
        throw new SkillboxError(ErrorCode.MANIFEST_NOT_FOUND, `No skillbox.yaml found in "${REPO}"`)
      },
    }
    h.sync = new SyncService({
      repositoryRoot: REPO,
      registry: new AgentRegistry(),
      gitProvider: h.git,
      githubProvider: h.github,
      secretScanner: h.secrets,
      skills: skills as unknown as SkillService,
      out: () => undefined,
      sleep: async () => undefined,
    })
    const error = await h.sync.sync().catch((e: unknown) => e)
    expect(isSkillboxError(error)).toBe(true)
    expect(error).toMatchObject({ code: ErrorCode.MANIFEST_NOT_FOUND })
  })
})

describe('SyncService.pull / push / gitStatus', () => {
  it('pulls, reconciles and reports conflicts on conflict', async () => {
    const h = harness()
    const result = await h.sync.pull()
    expect(result.pulledFiles).toEqual(['skills/foo/SKILL.md'])
    expect(result.conflicts).toEqual([])

    h.git.pullResult = { conflicts: ['skillbox.yaml'], changedFiles: [] }
    const error = await h.sync.pull().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: ErrorCode.GIT_CONFLICT })
  })

  it('requires a remote for pull and push', async () => {
    const h = harness()
    h.git.statusResult = {
      isRepository: true,
      ahead: 0,
      behind: 0,
      changedFiles: [],
      stagedFiles: [],
      conflicts: [],
    }
    const error = await h.sync.push().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: ErrorCode.GIT_REMOTE_NOT_FOUND })
  })

  it('gate-on-connect before pushing', async () => {
    const h = harness()
    h.github.state = 'refresh-required'
    const error = await h.sync.push().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: ErrorCode.GITHUB_NOT_CONNECTED })
    expect(h.git.pushCalls).toBe(0)
  })

  it('gitStatus delegates to the provider', async () => {
    const h = harness()
    const git = await h.sync.gitStatus()
    expect(git.isRepository).toBe(true)
    expect(git.remote?.name).toBe('origin')
  })
})

describe('SyncService.connect / disconnect', () => {
  it('prints the device flow and polls until connected', async () => {
    const h = harness()
    h.github.state = 'not-connected'
    h.github.pollQueue = ['authorizing', 'connected']
    const result = await h.sync.connect()
    expect(result.state).toBe('connected')
    expect(result.alreadyConnected).toBe(false)
    expect(h.github.started).toBe(1)
    expect(h.out()).toContain('ABCD-EFGH')
    expect(h.out()).toContain('https://github.com/login/device')
  })

  it('short-circuits when already connected', async () => {
    const h = harness()
    const result = await h.sync.connect()
    expect(result.alreadyConnected).toBe(true)
    expect(h.github.started).toBe(0)
  })

  it('fails with an expired device code', async () => {
    const h = harness()
    h.github.state = 'authorizing'
    h.github.start.expiresInMs = 0
    const error = await h.sync.connect().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: ErrorCode.GITHUB_AUTHORIZATION_EXPIRED })
  })

  it('disconnect delegates to the provider', async () => {
    const h = harness()
    await h.sync.disconnect()
    expect(h.github.disconnected).toBe(1)
  })
})

describe('loaders (wiring points)', () => {
  it('fails with GIT_UNAVAILABLE until the core GitClient exists', async () => {
    const provider = createGitProviderFromCore(REPO, async () => ({}))
    const error = await provider.status().catch((e: unknown) => e)
    expect(isSkillboxError(error)).toBe(true)
    expect(error).toMatchObject({ code: ErrorCode.GIT_UNAVAILABLE })
  })

  it('adapts an available core GitClient onto the interface', async () => {
    const fake = new FakeGitProvider()
    const FakeGitClient = class {
      constructor(_root: string) {}
      status = async () => ({
        branch: 'main',
        remote: { name: 'origin', url: 'https://github.com/u/repo.git' },
        ahead: 2,
        behind: 3,
        files: [
          {
            path: 'skillbox.lock',
            conflict: false,
            staged: true,
            unstaged: false,
            untracked: false,
          },
        ],
        conflicts: [] as Array<{ path: string }>,
        staged: [
          {
            path: 'skillbox.lock',
            conflict: false,
            staged: true,
            unstaged: false,
            untracked: false,
          },
        ],
        unstaged: [] as Array<{ path: string }>,
        untracked: [] as Array<{ path: string }>,
        clean: false,
      })
      pull = () => fake.pull()
      commit = (message: string, paths: readonly string[]) => fake.commit(message, paths)
      push = () => fake.push()
    }
    const provider = createGitProviderFromCore(REPO, async () => ({ GitClient: FakeGitClient }))
    const report = await provider.status()
    expect(report).toMatchObject({
      isRepository: true,
      branch: 'main',
      remote: { name: 'origin', url: 'https://github.com/u/repo.git' },
      ahead: 2,
      behind: 3,
    })
    await provider.push()
    expect(fake.pushCalls).toBe(1)
  })

  it('fails with GITHUB_UNAVAILABLE until the core GitHubService exists', async () => {
    const provider = createGitHubProviderFromCore('C:\\home', async () => ({}))
    const error = await provider.connectionState().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: ErrorCode.GITHUB_UNAVAILABLE })
  })

  it('default GitHub provider reads the shipped core connection state', async () => {
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-github-wiring-'))
    try {
      const provider = createDefaultGitHubProvider(homeRoot, {
        credentialStore: new MemoryCredentialStore(),
      })
      await expect(provider.connectionState()).resolves.toBe('not-connected')
    } finally {
      await fs.rm(homeRoot, { recursive: true, force: true })
    }
  })

  it('secret scanner reports not-ready and empty scans when unwired', async () => {
    const scanner = createSecretScannerFromCore('C:\\repo', async () => ({}))
    expect(await scanner.isReady()).toBe(false)
    const result = await scanner.scanChangedFiles(['skills/foo/SKILL.md'])
    expect(result).toEqual({ findings: [], blocked: false })
  })

  it('default secret scanner wires against the shipped core scanFiles', async () => {
    const scanner = createDefaultSecretScanner('C:\\repo')
    expect(await scanner.isReady()).toBe(true)
  })
})
