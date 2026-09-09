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

export interface SyncRequest {
  /** A presentation-only label for the device initiating the sync. */
  deviceLabel?: string
}

export interface SyncSummary {
  automaticallyMerged: number
  createdSnapshotId?: string
  retriedPushes: number
}

export type SyncBlocker =
  | 'git-merge-in-progress'
  | 'operation-locked'
  | 'validation-failed'
  | 'push-retry-exhausted'
  | 'recovery-required'

export interface SyncRecovery {
  message: string
  retryable: boolean
  snapshotId?: string
}

export type ConflictType =
  'content' | 'delete-modify' | 'manifest-field' | 'mode' | 'source' | 'lifecycle'

export type ConflictResolution = 'local' | 'remote' | 'keep-both' | 'merged' | 'delete' | 'restore'

export interface ConflictValue {
  /** Safe, bounded data suitable for a conflict preview. */
  preview?: string
  value?: unknown
}

export interface SyncConflict {
  id: string
  type: ConflictType
  skillAlias?: string
  path?: string
  field?: string
  base?: ConflictValue
  local?: ConflictValue
  remote?: ConflictValue
  allowedResolutions: ConflictResolution[]
  recommendedResolution?: ConflictResolution
  destructive: boolean
}

export interface ConflictSession {
  version: 1
  id: string
  repositoryId: string
  baseRevision: string
  localRevision: string
  remoteRevision: string
  snapshotId: string
  createdAt: string
  expiresAt: string
  conflicts: SyncConflict[]
}

export interface ResolveConflictsRequest {
  sessionId: string
  resolutions: Record<string, ConflictResolution>
}

export type SyncOutcome =
  | { kind: 'completed'; summary: SyncSummary }
  | { kind: 'conflicts'; session: ConflictSession }
  | { kind: 'blocked'; reason: SyncBlocker; recovery: SyncRecovery }

export type RepositorySyncPhase =
  | 'authorize'
  | 'repository'
  | 'init'
  | 'bind-remote'
  | 'persist'
  | 'pull'
  | 'push'
  | 'preflight'
  | 'fetch'
  | 'snapshot'
  | 'merge'
  | 'validate'
  | 'commit'
  | 'retry-push'
  | 'reconcile'
  | 'conflicts'

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
  sync(input?: SyncRequest): Promise<SyncOutcome>
  /** Durable semantic conflicts awaiting a user decision for this repository. */
  listConflicts(): Promise<ConflictSession[]>
  getConflict(sessionId: string): Promise<ConflictSession>
  resolveConflicts(input: ResolveConflictsRequest): Promise<SyncOutcome>
  restoreSnapshot(snapshotId: string): Promise<void>
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
  /** Advanced operations used by the repository-level sync transaction. */
  fetch?(repositoryRoot: string, remote?: string, auth?: GitTransportAuth): Promise<void>
  revParse?(repositoryRoot: string, revision: string): Promise<string>
  mergeBase?(repositoryRoot: string, left: string, right: string): Promise<string>
  createWorktree?(repositoryRoot: string, targetDir: string, revision: string): Promise<void>
  removeWorktree?(repositoryRoot: string, targetDir: string): Promise<void>
  commit?(
    repositoryRoot: string,
    message: string,
    files?: readonly string[],
  ): Promise<{ hash: string }>
  stage?(repositoryRoot: string, files: readonly string[]): Promise<void>
  /** Opens an index-only merge whose managed content is supplied by a semantic transaction. */
  beginSemanticMerge?(repositoryRoot: string, otherRevision: string): Promise<void>
  abortMerge?(repositoryRoot: string): Promise<void>
  createPrivateRef?(repositoryRoot: string, name: string, revision: string): Promise<void>
  deletePrivateRef?(repositoryRoot: string, name: string): Promise<void>
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
