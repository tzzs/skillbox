import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { GitClient } from '../git/git-client.js'
import { LOCKFILE_FILE_NAME } from '../lockfile/schema.js'
import { MANIFEST_FILE_NAME } from '../manifest/schema.js'
import type {
  CollectDiagnosticsOptions,
  DiagnosticCheck,
  DiagnosticFilesystem,
  DiagnosticGit,
  DiagnosticReport,
  GitDiagnosticCheck,
  NodeDiagnosticCheck,
  RepositoryFileDiagnosticCheck,
} from './types.js'

/** The Node major version required by every published Skillbox package. */
export const MINIMUM_NODE_MAJOR = 20

function parseMajor(version: string): number | undefined {
  const match = /^(?:v)?(\d+)/.exec(version.trim())
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10)
}

/** Probes whether a Node version satisfies Skillbox's supported runtime floor. */
export function probeNodeCapability(
  version = process.versions.node,
  minimumMajor = MINIMUM_NODE_MAJOR,
): NodeDiagnosticCheck {
  const major = parseMajor(version)
  return {
    id: 'node',
    status: major !== undefined && major >= minimumMajor ? 'pass' : 'fail',
    version,
    minimumMajor,
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Probes whether Git is callable, without leaking an implementation exception. */
export async function probeGitCapability(
  git: DiagnosticGit = new GitClient(),
): Promise<GitDiagnosticCheck> {
  try {
    if (!(await git.isInstalled())) {
      return { id: 'git', status: 'fail', installed: false }
    }
    return { id: 'git', status: 'pass', installed: true, version: await git.gitVersion() }
  } catch (error) {
    return { id: 'git', status: 'fail', installed: false, detail: errorDetail(error) }
  }
}

/** Reports whether the repository contains the two Skillbox state documents. */
export async function probeRepositoryFiles(
  repositoryRoot: string,
  filesystem: DiagnosticFilesystem = new FilesystemService(),
): Promise<readonly RepositoryFileDiagnosticCheck[]> {
  const manifestPath = path.join(repositoryRoot, MANIFEST_FILE_NAME)
  const lockfilePath = path.join(repositoryRoot, LOCKFILE_FILE_NAME)
  const [manifestPresent, lockfilePresent] = await Promise.all([
    filesystem.exists(manifestPath),
    filesystem.exists(lockfilePath),
  ])
  return [
    {
      id: 'manifest',
      status: manifestPresent ? 'pass' : 'warn',
      present: manifestPresent,
      path: manifestPath,
    },
    {
      id: 'lockfile',
      status: lockfilePresent ? 'pass' : 'warn',
      present: lockfilePresent,
      path: lockfilePath,
    },
  ]
}

/**
 * Collects local prerequisite and repository-state probes into one ordered,
 * serializable report. Repository documents are advisory: a new repository is
 * still operationally ready once Node and Git are available.
 */
export async function collectDiagnostics(
  options: CollectDiagnosticsOptions,
): Promise<DiagnosticReport> {
  const node = probeNodeCapability(options.nodeVersion)
  const [git, repositoryFiles] = await Promise.all([
    probeGitCapability(options.git),
    probeRepositoryFiles(options.repositoryRoot, options.filesystem),
  ])
  const checks: readonly DiagnosticCheck[] = [node, git, ...repositoryFiles]
  return {
    repositoryRoot: options.repositoryRoot,
    ready: node.status === 'pass' && git.status === 'pass',
    checks,
  }
}
