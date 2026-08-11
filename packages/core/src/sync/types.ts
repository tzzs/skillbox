import type {
  AuthorizationState,
  DeviceAuthorization,
  DevicePollResult,
  EnsureRepositoryOptions,
  EnsureRepositoryResult,
  GitHubConnectionSnapshot,
  GitHubRepository,
  GitHubUser,
} from '../github/index.js'
import type {
  GitPullOptions,
  GitPushOptions,
  GitStatusResult,
  GitTransportAuth,
} from '../git/index.js'

export type RepositorySyncPhase =
  'authorize' | 'repository' | 'init' | 'bind-remote' | 'persist' | 'pull' | 'push'

export type RepositorySyncEvent =
  | { type: 'phase'; phase: RepositorySyncPhase }
  | { type: 'authorization-required'; authorization: DeviceAuthorization }

export interface RepositorySyncConnectResult {
  authorization: 'existing' | 'completed'
  account: { login: string }
  repository: GitHubRepository & { action: 'created' | 'reused' }
  local: {
    initialized: boolean
    remote: { name: 'origin'; url: string; action: 'added' | 'unchanged' }
  }
}

export interface RepositorySync {
  status(): Promise<GitStatusResult>
  connect(options?: EnsureRepositoryOptions): Promise<RepositorySyncConnectResult>
  disconnect(): Promise<void>
  pull(): Promise<void>
  push(): Promise<void>
  sync(): Promise<void>
}

export interface RepositoryGitPort {
  isInstalled(): Promise<boolean>
  isRepository(repositoryRoot: string): Promise<boolean>
  init(repositoryRoot: string): Promise<void>
  status(repositoryRoot: string): Promise<GitStatusResult>
  getRemote(
    repositoryRoot: string,
    name: string,
  ): Promise<{ name: string; url: string } | undefined>
  addRemote(repositoryRoot: string, name: string, url: string): Promise<void>
  removeRemote(repositoryRoot: string, name: string): Promise<void>
  pull(repositoryRoot: string, options?: GitPullOptions): Promise<void>
  push(repositoryRoot: string, options?: GitPushOptions): Promise<void>
}

export interface RepositoryHostPort {
  getConnectionState(): Promise<GitHubConnectionSnapshot>
  startDeviceAuthorization(): Promise<DeviceAuthorization>
  pollDeviceAuthorization(): Promise<DevicePollResult>
  getCurrentUser(): Promise<GitHubUser>
  getGitTransportAuth(): Promise<GitTransportAuth>
  resolveRepository(options?: EnsureRepositoryOptions): Promise<EnsureRepositoryResult>
  bindRepository(repository: GitHubRepository): Promise<void>
  disconnect(): Promise<void>
}

export type { AuthorizationState }
