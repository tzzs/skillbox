/** Severity emitted by a non-throwing environment diagnostic. */
export type DiagnosticStatus = 'pass' | 'warn' | 'fail'

/** The three diagnostic capabilities currently checked by Core. */
export type DiagnosticCheckId = 'node' | 'git' | 'manifest' | 'lockfile'

export interface NodeDiagnosticCheck {
  id: 'node'
  status: DiagnosticStatus
  version: string
  minimumMajor: number
}

export interface GitDiagnosticCheck {
  id: 'git'
  status: DiagnosticStatus
  installed: boolean
  version?: string
  /** A safe, one-line reason when the probe itself could not run. */
  detail?: string
}

export interface RepositoryFileDiagnosticCheck {
  id: 'manifest' | 'lockfile'
  status: 'pass' | 'warn'
  present: boolean
  path: string
}

export type DiagnosticCheck =
  NodeDiagnosticCheck | GitDiagnosticCheck | RepositoryFileDiagnosticCheck

/** Stable, serializable result returned by {@link collectDiagnostics}. */
export interface DiagnosticReport {
  repositoryRoot: string
  /** True when mandatory local capabilities (Node and Git) are available. */
  ready: boolean
  checks: readonly DiagnosticCheck[]
}

/** Narrow filesystem seam used by repository-file diagnostics. */
export interface DiagnosticFilesystem {
  exists(target: string): Promise<boolean>
}

/** Narrow Git seam used by the capability probe. */
export interface DiagnosticGit {
  isInstalled(): Promise<boolean>
  gitVersion(repositoryRoot?: string): Promise<string>
}

export interface CollectDiagnosticsOptions {
  repositoryRoot: string
  nodeVersion?: string
  filesystem?: DiagnosticFilesystem
  git?: DiagnosticGit
}
