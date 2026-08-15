import { describe, expect, it } from 'vitest'
import {
  AgentRegistry,
  ErrorCode,
  isSkillboxError,
  SkillboxError,
  type SkillService,
} from '@skillbox/core'
import {
  SyncService,
  createSyncGitTransport,
  type GitCommitOutcome,
  type GitProvider,
  type GitPullOutcome,
  type GitStatusReport,
  type GitHubProvider,
  type SyncGitTransport,
} from './index.js'

const REPO = 'C:\\repo'

function reconcileResult(root: string) {
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

/** Fake GitProvider recording every call (used to observe the fallback path). */
class FakeGitProvider implements GitProvider {
  statusResult: GitStatusReport = {
    isRepository: true,
    ahead: 0,
    behind: 1,
    remote: { name: 'origin', url: 'https://github.com/u/repo.git' },
    changedFiles: ['skills/foo/SKILL.md'],
    stagedFiles: [],
    conflicts: [],
  }
  pullResult: GitPullOutcome = { conflicts: [], changedFiles: ['skills/foo/SKILL.md'] }
  pullCalls = 0
  pushCalls = 0

  async status(): Promise<GitStatusReport> {
    return this.statusResult
  }
  async pull(): Promise<GitPullOutcome> {
    this.pullCalls += 1
    return this.pullResult
  }
  async commit(_message: string, _paths: readonly string[]): Promise<GitCommitOutcome> {
    return { committed: false, message: _message }
  }
  async push(): Promise<void> {
    this.pushCalls += 1
  }
}

/** Fake RepositorySync port recording pull/push delegation. */
class FakeRepositorySync {
  pulls = 0
  pushes = 0
  pullError?: Error
  async pull(): Promise<void> {
    this.pulls += 1
    if (this.pullError !== undefined) {
      throw this.pullError
    }
  }
  async push(): Promise<void> {
    this.pushes += 1
  }
}

function fakeGitHub(): GitHubProvider {
  return {
    connectionState: async () => 'connected',
    startDeviceFlow: async () => ({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      intervalMs: 0,
      expiresInMs: 10_000,
    }),
    pollDeviceFlow: async () => ({ status: 'authorized' }),
    disconnect: async () => undefined,
  }
}

function makeSyncService(gitTransport?: SyncGitTransport): SyncService {
  const git = new FakeGitProvider()
  return new SyncService({
    repositoryRoot: REPO,
    registry: new AgentRegistry(),
    gitProvider: git,
    githubProvider: fakeGitHub(),
    secretScanner: {
      isReady: async () => false,
      scanChangedFiles: async () => ({ findings: [], blocked: false }),
    },
    skills: { install: async () => reconcileResult(REPO) } as unknown as SkillService,
    out: () => undefined,
    ...(gitTransport !== undefined ? { gitTransport } : {}),
  })
}

describe('createSyncGitTransport', () => {
  it('delegates pull and maps the post-pull status to the outcome', async () => {
    const git = new FakeGitProvider()
    const repositorySync = new FakeRepositorySync()
    const transport = createSyncGitTransport(repositorySync, git)

    const outcome = await transport.pull()

    expect(repositorySync.pulls).toBe(1)
    expect(outcome).toEqual({
      conflicts: [],
      changedFiles: ['skills/foo/SKILL.md'],
    })
  })

  it('reports conflicts from status when the repository sync pull throws', async () => {
    const git = new FakeGitProvider()
    const repositorySync = new FakeRepositorySync()
    repositorySync.pullError = new Error('git pull failed with conflicts')
    git.statusResult = {
      ...git.statusResult,
      conflicts: ['skillbox.lock'],
      changedFiles: ['skillbox.lock'],
    }
    const transport = createSyncGitTransport(repositorySync, git)

    const outcome = await transport.pull()

    expect(repositorySync.pulls).toBe(1)
    expect(outcome).toEqual({ conflicts: ['skillbox.lock'], changedFiles: ['skillbox.lock'] })
  })

  it('rethrows the original error when a failed pull leaves no conflicts', async () => {
    const git = new FakeGitProvider()
    const repositorySync = new FakeRepositorySync()
    repositorySync.pullError = new Error('network is down')
    const transport = createSyncGitTransport(repositorySync, git)

    await expect(transport.pull()).rejects.toThrow('network is down')
  })

  it('falls back to the plain git pull when GitHub is not connected (public remotes)', async () => {
    const git = new FakeGitProvider()
    const repositorySync = new FakeRepositorySync()
    repositorySync.pullError = new SkillboxError(
      ErrorCode.GITHUB_NOT_CONNECTED,
      'GitHub is not connected',
    )
    const transport = createSyncGitTransport(repositorySync, git)

    const outcome = await transport.pull()

    expect(git.pullCalls).toBe(1)
    expect(outcome).toEqual({
      conflicts: [],
      changedFiles: ['skills/foo/SKILL.md'],
    })
  })

  it('delegates push', async () => {
    const git = new FakeGitProvider()
    const repositorySync = new FakeRepositorySync()
    const transport = createSyncGitTransport(repositorySync, git)

    await transport.push()

    expect(repositorySync.pushes).toBe(1)
  })
})

describe('SyncService with a git transport', () => {
  it('routes pull and push through the transport instead of the git provider', async () => {
    const git = new FakeGitProvider()
    const repositorySync = new FakeRepositorySync()
    const transport = createSyncGitTransport(repositorySync, git)
    const sync = makeSyncService(transport)

    const result = await sync.sync()

    expect(repositorySync.pulls).toBe(1)
    expect(repositorySync.pushes).toBe(1)
    expect(git.pullCalls).toBe(0)
    expect(git.pushCalls).toBe(0)
    expect(result.steps.find((step) => step.step === 'pull')?.status).toBe('ok')
    expect(result.steps.find((step) => step.step === 'push')?.status).toBe('ok')
  })

  it('surfaces a typed GIT_CONFLICT when the transport reports conflicts', async () => {
    const git = new FakeGitProvider()
    const repositorySync = new FakeRepositorySync()
    repositorySync.pullError = new Error('pull failed')
    git.statusResult = {
      ...git.statusResult,
      conflicts: ['skillbox.lock'],
    }
    const transport = createSyncGitTransport(repositorySync, git)
    const sync = makeSyncService(transport)

    const error = await sync.sync().catch((e: unknown) => e)

    expect(isSkillboxError(error)).toBe(true)
    expect(error).toMatchObject({ code: ErrorCode.GIT_CONFLICT })
    expect(repositorySync.pushes).toBe(0)
  })

  it('routes single-shot pull and push through the transport', async () => {
    const git = new FakeGitProvider()
    const repositorySync = new FakeRepositorySync()
    const transport = createSyncGitTransport(repositorySync, git)
    const sync = makeSyncService(transport)

    await sync.pull()
    await sync.push()

    expect(repositorySync.pulls).toBe(1)
    expect(repositorySync.pushes).toBe(1)
    expect(git.pullCalls).toBe(0)
    expect(git.pushCalls).toBe(0)
  })
})
