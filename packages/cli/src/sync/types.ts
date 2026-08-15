/**
 * Shared sync types. Re-exports the provider contracts plus the pipeline's
 * step vocabulary so commands/tests import from a single surface.
 */
export type {
  DeviceFlowStart,
  DeviceFlowPollResult,
  GitHubProvider,
  GitCommitOutcome,
  GitProvider,
  GitPullOutcome,
  GitStatusReport,
  GithubConnectionState,
  SecretFinding,
  SecretScanResult,
  SecretScanner,
  SecretSeverity,
  SyncGitTransport,
} from './providers.js'

export type SyncStepId = 'scan' | 'detect' | 'secret-scan' | 'pull' | 'resolve' | 'commit' | 'push'

export type SyncStepStatus = 'ok' | 'skipped' | 'warning'
