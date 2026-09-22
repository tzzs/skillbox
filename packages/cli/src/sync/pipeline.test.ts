import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentRegistry,
  ErrorCode,
  isSkillboxError,
  MemoryCredentialStore,
  SkillboxError,
  type GitFileStatus,
  type GitStatusResult,
  type ReconcileResult,
  type ScanResult,
  type SkillService,
} from '@skillbox/core'
import {
  createDefaultGitHubProvider,
  createDefaultGitProvider,
  createDefaultSecretScanner,
  SyncService,
  type CoreGitClient,
  type CoreSecretScan,
  type DeviceFlowStart,
  type DeviceFlowPollResult,
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

const execFileP = promisify(execFile)

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
  pollQueue: DeviceFlowPollResult[] = []
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
  async pollDeviceFlow(): Promise<DeviceFlowPollResult> {
    return this.pollQueue.shift() ?? { status: 'pending' }
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
  sleeps: number[]
  out(): string
}

function harness(
  options: { managedPathExists?: (relative: string) => Promise<boolean> } = {},
): Harness {
  const chunks: string[] = []
  const git = new FakeGitProvider()
  const github = new FakeGitHubProvider()
  const secrets = new FakeSecretScanner()
  const sleeps: number[] = []
  const skills = { install: async () => reconcileResult(REPO) } as unknown as SkillService
  const sync = new SyncService({
    repositoryRoot: REPO,
    registry: new AgentRegistry(),
    gitProvider: git,
    githubProvider: github,
    secretScanner: secrets,
    skills,
    out: (chunk) => chunks.push(chunk),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    // The fake repository root is a Windows-style path that does not exist, so
    // the owned-path probe is injected rather than read from disk.
    managedPathExists: options.managedPathExists ?? (async () => true),
  })
  return { sync, git, github, secrets, sleeps, out: () => chunks.join('') }
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

  it('stages only the owned paths that exist in the repository', async () => {
    // `git add -- <pathspec>` fails the whole staging when one pattern matches
    // nothing, so a repository without `skills/` yet must not be handed it.
    const h = harness({
      managedPathExists: async (relative) =>
        relative === 'skillbox.yaml' || relative === 'skillbox.lock',
    })
    const result = await h.sync.sync()

    expect(h.git.commits[0]?.paths).toEqual(['skillbox.yaml', 'skillbox.lock'])
    expect(result.steps.find((step) => step.step === 'commit')?.status).toBe('ok')
    expect(result.committed).toBe(true)
  })

  it('skips the commit when none of the owned paths exist', async () => {
    const h = harness({ managedPathExists: async () => false })
    const result = await h.sync.sync()

    expect(h.git.commits).toEqual([])
    expect(result.committed).toBe(false)
    expect(result.steps.find((step) => step.step === 'commit')).toMatchObject({
      status: 'skipped',
      detail: 'no skillbox changes to commit',
    })
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
    h.github.pollQueue = [{ status: 'pending' }, { status: 'authorized' }]
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

  it.each([
    ['denied', ErrorCode.GITHUB_AUTHORIZATION_DENIED],
    ['expired', ErrorCode.GITHUB_AUTHORIZATION_EXPIRED],
    ['failed', ErrorCode.GITHUB_AUTH_FAILED],
  ] as const)('stops immediately when device authorization is %s', async (status, code) => {
    const h = harness()
    h.github.state = 'not-connected'
    h.github.pollQueue = [{ status }]
    const error = await h.sync.connect().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code })
    expect(h.github.pollQueue).toHaveLength(0)
  })

  it('uses the slower interval returned by GitHub for later polls', async () => {
    const h = harness()
    h.github.state = 'not-connected'
    h.github.start.intervalMs = 1_000
    h.github.pollQueue = [{ status: 'slow-down', intervalMs: 7_000 }, { status: 'authorized' }]
    await h.sync.connect()
    expect(h.sleeps).toEqual([1_000, 7_000])
  })

  it('disconnect delegates to the provider', async () => {
    const h = harness()
    await h.sync.disconnect()
    expect(h.github.disconnected).toBe(1)
  })
})

describe('loaders (wiring points)', () => {
  const gitFile = (over: Partial<GitFileStatus> = {}): GitFileStatus => ({
    xy: 'M ',
    path: 'skillbox.lock',
    staged: true,
    unstaged: false,
    untracked: false,
    conflict: false,
    ...over,
  })

  const statusResult = (over: Partial<GitStatusResult> = {}, detached = false): GitStatusResult => {
    const result: GitStatusResult = {
      repositoryRoot: REPO,
      branch: 'main',
      remote: { name: 'origin', url: 'https://github.com/u/repo.git' },
      ahead: 2,
      behind: 3,
      files: [gitFile({})],
      conflicts: [],
      hasConflicts: false,
      staged: [gitFile({})],
      unstaged: [],
      untracked: [],
      clean: false,
      ...over,
    }
    if (detached) {
      delete result.branch
    }
    return result
  }

  const clientOf = (over: Partial<CoreGitClient>): CoreGitClient => ({
    status: async () => statusResult(),
    pull: async () => undefined,
    push: async () => undefined,
    commit: async () => ({ hash: 'abc1234def' }),
    ...over,
  })

  it('fails with GIT_UNAVAILABLE when the git binary is missing', async () => {
    const provider = createDefaultGitProvider(REPO, clientOf({ isInstalled: async () => false }))
    for (const call of [
      () => provider.status(),
      () => provider.pull(),
      () => provider.commit('skillbox: sync', []),
      () => provider.push(),
    ]) {
      const error = await call().catch((e: unknown) => e)
      expect(isSkillboxError(error)).toBe(true)
      expect(error).toMatchObject({ code: ErrorCode.GIT_UNAVAILABLE })
    }
  })

  it('adapts the core GitClient onto the CLI git contract', async () => {
    const fake = new FakeGitProvider()
    const roots: string[] = []
    const committed: Array<{ root: string; paths: readonly string[] | undefined }> = []
    const provider = createDefaultGitProvider(
      REPO,
      clientOf({
        status: async (root) => {
          roots.push(root)
          return statusResult()
        },
        pull: async (root) => {
          roots.push(root)
          await fake.pull()
        },
        commit: async (root, message, paths) => {
          committed.push({ root, paths })
          await fake.commit(message, paths ?? [])
          return { hash: 'abc1234def' }
        },
        push: async (root) => {
          roots.push(root)
          await fake.push()
        },
      }),
    )

    const report = await provider.status()
    // The core client is rootless: the adapter passes the configured root per call.
    expect(report).toMatchObject({
      isRepository: true,
      branch: 'main',
      remote: { name: 'origin', url: 'https://github.com/u/repo.git' },
      ahead: 2,
      behind: 3,
      changedFiles: ['skillbox.lock'],
      stagedFiles: ['skillbox.lock'],
      conflicts: [],
    })

    expect(await provider.commit('skillbox: sync', ['skillbox.lock'])).toMatchObject({
      committed: true,
      shortHash: 'abc1234',
    })
    const pull = await provider.pull()
    expect(pull).toEqual({ conflicts: [], changedFiles: ['skillbox.lock'] })
    await provider.push()
    expect(roots.every((root) => root === REPO)).toBe(true)
    expect(committed).toEqual([{ root: REPO, paths: ['skillbox.lock'] }])
    expect(fake.pushCalls).toBe(1)
  })

  it('falls back to currentBranch() when the status result has no branch', async () => {
    const provider = createDefaultGitProvider(
      REPO,
      clientOf({
        status: async () => statusResult({ files: [], staged: [] }, true),
        currentBranch: async () => 'feature/sync',
      }),
    )
    expect(await provider.status()).toMatchObject({
      branch: 'feature/sync',
      changedFiles: [],
      stagedFiles: [],
    })
  })

  it('reports a failed status as a non-repository and empty commit as nothing to commit', async () => {
    const notARepository = createDefaultGitProvider(
      REPO,
      clientOf({
        status: async () => {
          throw new SkillboxError(ErrorCode.GIT_COMMAND_FAILED, 'git status failed', {
            context: { stderr: 'fatal: not a git repository' },
          })
        },
      }),
    )
    expect(await notARepository.status()).toMatchObject({
      isRepository: false,
      changedFiles: [],
      conflicts: [],
    })

    const clean = createDefaultGitProvider(
      REPO,
      clientOf({
        commit: async () => {
          throw new SkillboxError(
            ErrorCode.GIT_COMMAND_FAILED,
            'nothing to commit, working tree clean',
          )
        },
      }),
    )
    expect(await clean.commit('skillbox: sync', ['skillbox.lock'])).toEqual({
      committed: false,
      message: 'skillbox: sync',
    })
  })

  it('drives a real git working tree through the shipped core GitClient', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-git-wiring-'))
    try {
      const git = async (args: string[]): Promise<string> =>
        (await execFileP('git', ['-C', root, ...args])).stdout
      await git(['init', '-b', 'main'])
      await git(['config', 'user.email', 'skillbox@example.test'])
      await git(['config', 'user.name', 'skillbox'])
      await fs.writeFile(path.join(root, 'skillbox.yaml'), 'skills: {}\n')
      await git(['add', 'skillbox.yaml'])
      await git(['commit', '-m', 'init'])
      await fs.writeFile(path.join(root, 'skillbox.yaml'), 'skills:\n  demo: {}\n')
      await fs.writeFile(path.join(root, 'notes.md'), 'untracked\n')

      const provider = createDefaultGitProvider(root)
      const report = await provider.status()
      expect(report).toMatchObject({ isRepository: true, branch: 'main' })
      expect(report.changedFiles).toContain('skillbox.yaml')
      expect(report.conflicts).toEqual([])

      const committed = await provider.commit('skillbox: sync 1 change', ['skillbox.yaml'])
      expect(committed).toMatchObject({ committed: true, message: 'skillbox: sync 1 change' })
      expect(committed.shortHash).toMatch(/^[0-9a-f]{7}$/)
      // Re-running the same commit has nothing left to stage.
      expect(await provider.commit('skillbox: sync 1 change', ['skillbox.yaml'])).toMatchObject({
        committed: false,
      })

      const after = await provider.status()
      expect(after.changedFiles).not.toContain('skillbox.yaml')
      // Only the named paths are committed; everything else stays dirty.
      expect(after.changedFiles).toContain('notes.md')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
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

  it('default GitHub provider maps Device Flow seconds to CLI milliseconds', async () => {
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-github-device-'))
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 7,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', request)
    try {
      const provider = createDefaultGitHubProvider(homeRoot, {
        clientId: 'test-client-id',
        credentialStore: new MemoryCredentialStore(),
      })
      await expect(provider.startDeviceFlow()).resolves.toEqual({
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        intervalMs: 7_000,
        expiresInMs: 900_000,
      })
    } finally {
      vi.unstubAllGlobals()
      await fs.rm(homeRoot, { recursive: true, force: true })
    }
  })

  it('default GitHub provider preserves slow-down and denied poll outcomes', async () => {
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-github-poll-'))
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: 'device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'slow_down', interval: 12 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'access_denied' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', request)
    try {
      const provider = createDefaultGitHubProvider(homeRoot, {
        clientId: 'test-client-id',
        credentialStore: new MemoryCredentialStore(),
      })
      await provider.startDeviceFlow()
      await expect(provider.pollDeviceFlow()).resolves.toEqual({
        status: 'slow-down',
        intervalMs: 12_000,
      })
      await expect(provider.pollDeviceFlow()).resolves.toEqual({ status: 'denied' })
    } finally {
      vi.unstubAllGlobals()
      await fs.rm(homeRoot, { recursive: true, force: true })
    }
  })

  it('default GitHub provider disconnect clears credentials and machine metadata', async () => {
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-github-disconnect-'))
    const store = new MemoryCredentialStore()
    await store.set(
      { service: 'skillbox-github', account: 'oauth-tokens' },
      JSON.stringify({ accessToken: 'test-token', tokenType: 'bearer' }),
    )
    await fs.writeFile(
      path.join(homeRoot, 'config.json'),
      JSON.stringify({ github: { connected: true, login: 'octocat', provider: 'github-app' } }),
    )
    try {
      const provider = createDefaultGitHubProvider(homeRoot, { credentialStore: store })
      await expect(provider.connectionState()).resolves.toBe('connected')
      await provider.disconnect()
      await expect(provider.connectionState()).resolves.toBe('not-connected')
      await expect(
        store.get({ service: 'skillbox-github', account: 'oauth-tokens' }),
      ).resolves.toBeNull()
      await expect(fs.readFile(path.join(homeRoot, 'config.json'), 'utf8')).resolves.not.toContain(
        'github',
      )
    } finally {
      await fs.rm(homeRoot, { recursive: true, force: true })
    }
  })

  it('maps core scan results onto the CLI secret-scan contract', async () => {
    const seen: Array<{ files: readonly string[]; root: string | undefined }> = []
    const scan: CoreSecretScan = async (files, options) => {
      seen.push({ files, root: options?.root })
      const result: ScanResult = {
        filesScanned: files.length,
        findings: [
          {
            file: 'skills/foo/SKILL.md',
            line: 12,
            patternId: 'aws-access-key',
            name: 'AWS access key id',
            severity: 'high',
            scope: 'content',
            snippet: 'AKIA****',
            recommendation: 'Rotate the key.',
          },
        ],
        blocked: [],
        warnings: [],
        infos: [],
        block: true,
        skippedByIgnore: [],
        skippedByPolicy: [],
      }
      return result
    }
    const scanner = createDefaultSecretScanner(REPO, scan)
    expect(await scanner.isReady()).toBe(true)
    expect(await scanner.scanChangedFiles(['skills/foo/SKILL.md'])).toEqual({
      blocked: true,
      findings: [
        {
          path: 'skills/foo/SKILL.md',
          rule: 'aws-access-key',
          severity: 'high',
          message: '[AWS access key id] AKIA****',
        },
      ],
    })
    // The scanner anchors relative paths on the configured repository root.
    expect(seen).toEqual([{ files: ['skills/foo/SKILL.md'], root: REPO }])
  })

  it('default secret scanner runs the shipped core scanFiles', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-secret-scan-'))
    try {
      await fs.writeFile(path.join(root, 'SKILL.md'), '# Instructions\n\nRun the tests.\n')
      const scanner = createDefaultSecretScanner(root)
      expect(await scanner.isReady()).toBe(true)
      expect(await scanner.scanChangedFiles(['SKILL.md'])).toEqual({
        findings: [],
        blocked: false,
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
