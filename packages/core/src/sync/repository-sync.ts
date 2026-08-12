import { ErrorCode, SkillboxError } from '../errors.js'
import type { EnsureRepositoryOptions } from '../github/index.js'
import type {
  RepositoryGitPort,
  RepositoryHostPort,
  RepositorySync,
  RepositorySyncConnectResult,
  RepositorySyncEvent,
  SyncOutcome,
  SyncRequest,
  ResolveConflictsRequest,
} from './types.js'

export interface RepositorySyncServiceOptions {
  repositoryRoot: string
  git: RepositoryGitPort
  host: RepositoryHostPort
  onEvent?: (event: RepositorySyncEvent) => void
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}

/** Owns the GitHub-account, hosted-repository, and local-Git consistency boundary. */
export class RepositorySyncService implements RepositorySync {
  private readonly repositoryRoot: string
  private readonly git: RepositoryGitPort
  private readonly host: RepositoryHostPort
  private readonly onEvent: (event: RepositorySyncEvent) => void
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number

  constructor(options: RepositorySyncServiceOptions) {
    this.repositoryRoot = options.repositoryRoot
    this.git = options.git
    this.host = options.host
    this.onEvent = options.onEvent ?? (() => undefined)
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.now = options.now ?? (() => Date.now())
  }

  async status() {
    return this.git.status(this.repositoryRoot)
  }

  async connect(options: EnsureRepositoryOptions = {}): Promise<RepositorySyncConnectResult> {
    if (!(await this.git.isInstalled())) {
      throw new SkillboxError(ErrorCode.GIT_NOT_FOUND, 'Git is required to connect this repository')
    }

    const authorization = await this.authorize()
    const account = await this.host.getCurrentUser()
    this.phase('repository')
    const resolved = await this.host.resolveRepository(options)

    let initialized = false
    if (!(await this.git.isRepository(this.repositoryRoot))) {
      this.phase('init')
      await this.git.init(this.repositoryRoot)
      initialized = true
    }

    this.phase('bind-remote')
    const expectedUrl = resolved.repository.cloneUrl
    const existing = await this.git.getRemote(this.repositoryRoot, 'origin')
    let remoteAction: 'added' | 'unchanged'
    let added = false
    if (existing === undefined) {
      await this.git.addRemote(this.repositoryRoot, 'origin', expectedUrl)
      added = true
      remoteAction = 'added'
    } else if (canonicalRemoteUrl(existing.url) === canonicalRemoteUrl(expectedUrl)) {
      remoteAction = 'unchanged'
    } else {
      throw new SkillboxError(
        ErrorCode.GIT_REMOTE_CONFLICT,
        `Remote "origin" already points to "${existing.url}"; refusing to replace it with "${expectedUrl}".`,
        {
          recoverable: true,
          context: {
            phase: 'bind-remote',
            name: 'origin',
            current: existing.url,
            expected: expectedUrl,
          },
        },
      )
    }

    try {
      this.phase('persist')
      await this.host.bindRepository(resolved.repository)
    } catch (error) {
      if (added) {
        await this.git.removeRemote(this.repositoryRoot, 'origin')
      }
      throw error
    }

    return {
      authorization,
      account: { login: account.login },
      repository: {
        ...resolved.repository,
        action: resolved.reused ? 'reused' : 'created',
      },
      local: {
        initialized,
        remote: { name: 'origin', url: expectedUrl, action: remoteAction },
      },
    }
  }

  async disconnect(): Promise<void> {
    await this.host.disconnect()
  }

  async pull(): Promise<void> {
    const auth = await this.host.getGitTransportAuth()
    await this.git.pull(this.repositoryRoot, { auth })
  }

  async push(): Promise<void> {
    const status = await this.git.status(this.repositoryRoot)
    if (status.branch === undefined) {
      throw new SkillboxError(ErrorCode.GIT_DETACHED_HEAD, 'Cannot push from a detached HEAD', {
        recoverable: true,
        context: { phase: 'push' },
      })
    }
    const auth = await this.host.getGitTransportAuth()
    await this.git.push(this.repositoryRoot, {
      ...(status.remote === undefined ? {} : { remote: status.remote.name }),
      branch: status.branch,
      setUpstream: status.upstream === undefined,
      auth,
    })
  }

  async sync(_input: SyncRequest = {}): Promise<SyncOutcome> {
    const status = await this.status()
    if (status.hasConflicts) {
      return {
        kind: 'blocked',
        reason: 'git-merge-in-progress',
        recovery: {
          retryable: true,
          message: 'Finish or abort the existing repository operation before syncing again.',
        },
      }
    }
    try {
      // The transaction layer owns semantic merge in production. Retaining this
      // safe transport fallback keeps injected ports compatible and never
      // writes conflict markers itself.
      await this.pull()
      await this.push()
      return { kind: 'completed', summary: { automaticallyMerged: 0, retriedPushes: 0 } }
    } catch (error) {
      if (error instanceof SkillboxError && error.code === ErrorCode.GIT_PUSH_REJECTED) {
        return {
          kind: 'blocked',
          reason: 'push-retry-exhausted',
          recovery: { retryable: true, message: 'The other device changed the repository. Sync again.' },
        }
      }
      throw error
    }
  }

  async resolveConflicts(_input: ResolveConflictsRequest): Promise<SyncOutcome> {
    return {
      kind: 'blocked',
      reason: 'recovery-required',
      recovery: { retryable: true, message: 'No conflict resolver is configured for this repository.' },
    }
  }

  async restoreSnapshot(_snapshotId: string): Promise<void> {
    throw new SkillboxError(ErrorCode.SYNC_SNAPSHOT_NOT_FOUND, 'The requested sync restore point was not found.', {
      recoverable: true,
    })
  }

  private async authorize(): Promise<'existing' | 'completed'> {
    const snapshot = await this.host.getConnectionState()
    if (snapshot.state === 'connected') {
      return 'existing'
    }

    this.phase('authorize')
    const device = await this.host.startDeviceAuthorization()
    this.onEvent({ type: 'authorization-required', authorization: device })
    const deadline = this.now() + device.expiresIn * 1_000
    let intervalMs = device.interval * 1_000
    while (this.now() <= deadline) {
      await this.sleep(intervalMs)
      const result = await this.host.pollDeviceAuthorization()
      switch (result.status) {
        case 'authorized':
          return 'completed'
        case 'pending':
          break
        case 'slow-down':
          intervalMs = result.interval * 1_000
          break
        case 'denied':
          throw new SkillboxError(
            ErrorCode.GITHUB_AUTHORIZATION_DENIED,
            'GitHub authorization was denied',
            { recoverable: true, context: { phase: 'authorize' } },
          )
        case 'expired':
          throw this.authorizationExpired()
        case 'failed':
          throw new SkillboxError(
            ErrorCode.GITHUB_AUTH_FAILED,
            result.message ?? 'GitHub authorization failed',
            {
              recoverable: true,
              context: { phase: 'authorize' },
            },
          )
      }
    }
    throw this.authorizationExpired()
  }

  private authorizationExpired(): SkillboxError {
    return new SkillboxError(
      ErrorCode.GITHUB_AUTHORIZATION_EXPIRED,
      'GitHub device authorization expired',
      {
        recoverable: true,
        context: { phase: 'authorize' },
      },
    )
  }

  private phase(phase: Extract<RepositorySyncEvent, { type: 'phase' }>['phase']): void {
    this.onEvent({ type: 'phase', phase })
  }
}

function canonicalRemoteUrl(value: string): string {
  const trimmed = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .replace(/\.git$/i, '')
  try {
    const url = new URL(trimmed)
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return trimmed
  }
}
