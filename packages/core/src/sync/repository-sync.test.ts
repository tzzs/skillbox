import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../errors.js'
import { withTempDir } from '../fs/test-utils.js'
import { repositoryKey } from '../operations/lock.js'
import { GitClient } from '../git/index.js'
import type {
  DeviceAuthorization,
  DevicePollResult,
  GitHubConnectionSnapshot,
  GitHubRepository,
  GitHubUser,
} from '../github/index.js'
import type { GitPushOptions, GitStatusResult, GitTransportAuth } from '../git/index.js'
import { RepositorySyncService } from './repository-sync.js'
import { ConflictSessionStore } from './conflict-session-store.js'
import type { RepositoryGitPort, RepositoryHostPort } from './types.js'

const repository: GitHubRepository = {
  id: 1,
  name: 'skillbox-skills',
  owner: 'octocat',
  fullName: 'octocat/skillbox-skills',
  private: true,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/octocat/skillbox-skills',
  cloneUrl: 'https://github.com/octocat/skillbox-skills.git',
}

class FakeGit implements RepositoryGitPort {
  repository = false
  remote: { name: string; url: string } | undefined
  events: string[] = []
  failAdd = false
  pushOptions: GitPushOptions | undefined
  pullAuth: GitTransportAuth | undefined

  async isInstalled(): Promise<boolean> {
    return true
  }
  async isRepository(): Promise<boolean> {
    return this.repository
  }
  async init(): Promise<void> {
    this.events.push('init')
    this.repository = true
  }
  async status(): Promise<GitStatusResult> {
    return {
      repositoryRoot: '/repo',
      branch: 'main',
      ...(this.remote === undefined ? {} : { remote: this.remote }),
      ahead: 0,
      behind: 0,
      files: [],
      conflicts: [],
      hasConflicts: false,
      staged: [],
      unstaged: [],
      untracked: [],
      clean: true,
    }
  }
  async getRemote(): Promise<{ name: string; url: string } | undefined> {
    return this.remote
  }
  async addRemote(_root: string, name: string, url: string): Promise<void> {
    this.events.push('bind-remote')
    if (this.failAdd) throw new Error('add failed')
    this.remote = { name, url }
  }
  async removeRemote(): Promise<void> {
    this.events.push('remove-remote')
    this.remote = undefined
  }
  async pull(_root: string, options?: { auth?: GitTransportAuth }): Promise<void> {
    this.pullAuth = options?.auth
  }
  async push(_root: string, options?: GitPushOptions): Promise<void> {
    this.pushOptions = options
  }
}

class FakeHost implements RepositoryHostPort {
  events: string[] = []
  state: GitHubConnectionSnapshot = { state: 'connected', connected: true, login: 'octocat' }
  repository = repository

  async getConnectionState(): Promise<GitHubConnectionSnapshot> {
    return this.state
  }
  async startDeviceAuthorization(): Promise<DeviceAuthorization> {
    throw new Error('not expected')
  }
  async pollDeviceAuthorization(): Promise<DevicePollResult> {
    return { status: 'pending' }
  }
  async getCurrentUser(): Promise<GitHubUser> {
    return { id: 1, login: 'octocat', htmlUrl: 'https://github.com/octocat' }
  }
  async getGitTransportAuth(): Promise<GitTransportAuth> {
    return {
      prefixArgs: ['-c', 'credential.helper=!helper'],
      env: { SKILLBOX_GITHUB_ACCESS_TOKEN: 'secret' },
      sensitiveEnvKeys: ['SKILLBOX_GITHUB_ACCESS_TOKEN'],
    }
  }
  async resolveRepository(): Promise<{ repository: GitHubRepository; reused: boolean }> {
    this.events.push('resolve')
    return { repository: this.repository, reused: false }
  }
  async bindRepository(): Promise<void> {
    this.events.push('persist')
  }
  async disconnect(): Promise<void> {}
}

describe('RepositorySyncService.connect', () => {
  it('binds a real local Git repository to a hermetic bare remote', async () => {
    await withTempDir(async (dir) => {
      const repositoryRoot = path.join(dir, 'work')
      const remoteRoot = path.join(dir, 'remote.git')
      await fs.mkdir(repositoryRoot)
      await runGit(dir, ['init', '--bare', '--initial-branch=main', remoteRoot])
      const host = new FakeHost()
      host.repository = { ...repository, cloneUrl: remoteRoot }
      const git = new GitClient()
      const service = new RepositorySyncService({ repositoryRoot, git, host })

      await service.connect()

      expect(await git.isRepository(repositoryRoot)).toBe(true)
      expect(await git.getRemote(repositoryRoot, 'origin')).toEqual({
        name: 'origin',
        url: remoteRoot,
      })
      expect(host.events).toEqual(['resolve', 'persist'])
    })
  })

  it('initializes Git, binds origin, and persists repository metadata last', async () => {
    const git = new FakeGit()
    const host = new FakeHost()
    const order: string[] = []
    git.events = order
    host.events = order
    const service = new RepositorySyncService({ repositoryRoot: '/repo', git, host })

    const result = await service.connect()

    expect(order).toEqual(['resolve', 'init', 'bind-remote', 'persist'])
    expect(result).toMatchObject({
      authorization: 'existing',
      repository: { action: 'created' },
      local: { initialized: true, remote: { name: 'origin', action: 'added' } },
    })
  })

  it('does not persist repository metadata when remote binding fails', async () => {
    const git = new FakeGit()
    git.failAdd = true
    const host = new FakeHost()
    const order: string[] = []
    git.events = order
    host.events = order
    const service = new RepositorySyncService({ repositoryRoot: '/repo', git, host })

    await expect(service.connect()).rejects.toThrow('add failed')
    expect(order).toEqual(['resolve', 'init', 'bind-remote'])
  })

  it('rejects a conflicting origin without changing it or persisting metadata', async () => {
    const git = new FakeGit()
    git.repository = true
    git.remote = { name: 'origin', url: 'https://example.com/other.git' }
    const host = new FakeHost()
    const service = new RepositorySyncService({ repositoryRoot: '/repo', git, host })

    const error = await service.connect().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: ErrorCode.GIT_REMOTE_CONFLICT })
    expect(git.remote.url).toBe('https://example.com/other.git')
    expect(host.events).toEqual(['resolve'])
  })

  it('is idempotent for an authenticated repository with the expected origin', async () => {
    const git = new FakeGit()
    git.repository = true
    git.remote = { name: 'origin', url: repository.cloneUrl }
    const host = new FakeHost()
    const service = new RepositorySyncService({ repositoryRoot: '/repo', git, host })

    const result = await service.connect()

    expect(result.local).toEqual({
      initialized: false,
      remote: { name: 'origin', url: repository.cloneUrl, action: 'unchanged' },
    })
    expect(host.events).toEqual(['resolve', 'persist'])
  })
})

describe('RepositorySyncService transport', () => {
  it('injects one-shot credentials and establishes upstream on first push', async () => {
    const git = new FakeGit()
    git.repository = true
    git.remote = { name: 'origin', url: repository.cloneUrl }
    const host = new FakeHost()
    const service = new RepositorySyncService({ repositoryRoot: '/repo', git, host })

    await service.pull()
    await service.push()

    expect(git.pullAuth?.env.SKILLBOX_GITHUB_ACCESS_TOKEN).toBe('secret')
    expect(git.pushOptions).toMatchObject({
      remote: 'origin',
      branch: 'main',
      setUpstream: true,
    })
    expect(git.pushOptions?.auth?.env.SKILLBOX_GITHUB_ACCESS_TOKEN).toBe('secret')
  })
})

describe('RepositorySyncService conflict recovery wiring', () => {
  it('loads the durable session and rejects incomplete or invalid resolutions', async () => {
    await withTempDir(async (homeRoot) => {
      const git = new FakeGit()
      const service = new RepositorySyncService({
        repositoryRoot: '/repo',
        homeRoot,
        git,
        host: new FakeHost(),
      })
      const store = new ConflictSessionStore({ repositoryRoot: '/repo', homeRoot })
      await store.save({
        version: 1,
        id: 'session-1',
        repositoryId: repositoryKey('/repo'),
        baseRevision: 'base',
        localRevision: 'local',
        remoteRevision: 'remote',
        snapshotId: 'snapshot-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        conflicts: [
          { id: 'c1', type: 'content', allowedResolutions: ['local'], destructive: false },
        ],
      })

      await expect(
        service.resolveConflicts({ sessionId: 'session-1', resolutions: {} }),
      ).rejects.toMatchObject({ code: ErrorCode.SYNC_INVALID_CONFLICT_RESOLUTION })
      await expect(
        service.resolveConflicts({ sessionId: 'session-1', resolutions: { c1: 'remote' } }),
      ).rejects.toMatchObject({ code: ErrorCode.SYNC_INVALID_CONFLICT_RESOLUTION })
      await expect(
        service.resolveConflicts({ sessionId: 'session-1', resolutions: { c1: 'local' } }),
      ).resolves.toMatchObject({
        kind: 'blocked',
        recovery: { snapshotId: 'snapshot-1' },
      })
    })
  })
})

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}
