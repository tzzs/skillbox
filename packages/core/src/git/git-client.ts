import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { ErrorCode, SkillboxError } from '../errors.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { conflictsOf, parsePorcelainStatus, type GitFileStatus } from './porcelain.js'

/** Result of one spawned `git` process. */
export interface GitExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface GitSpawnOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Injectable process runner used by {@link GitClient}. Tests swap this for a
 * fake to simulate a missing `git` binary or scripted failures.
 */
export type GitSpawn = (args: string[], options: GitSpawnOptions) => Promise<GitExecResult>

export interface GitClientOptions {
  /** Process runner; defaults to `execFile('git', ...)`. */
  spawn?: GitSpawn
  filesystem?: FilesystemService
}

export interface GitStatusResult {
  repositoryRoot: string
  /** Current local branch; absent for detached HEAD. */
  branch?: string
  /** Configured upstream ref, for example `origin/main`. */
  upstream?: string
  /** Tracked remote derived from the upstream ref. */
  remote?: { name: string; url: string }
  /** Commits in HEAD but not in the tracked upstream. */
  ahead: number
  /** Commits in the tracked upstream but not in HEAD. */
  behind: number
  /** Every changed/untracked file, in git output order. */
  files: GitFileStatus[]
  /** Entries flagged as merge conflicts (`UU`/`AA`/`DD`/...). */
  conflicts: GitFileStatus[]
  hasConflicts: boolean
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  untracked: GitFileStatus[]
  clean: boolean
}

export interface GitDiffEntry {
  /** `git diff --name-status` letter (`M`/`A`/`D`/`R`/`C`/`T`/`U`). */
  status: string
  path: string
  /** Destination path for renames/copies. */
  newPath?: string
}

export interface GitDiffResult {
  files: GitDiffEntry[]
}

export interface GitCommitResult {
  /** Full 40-char commit object id. */
  hash: string
}

export interface GitPullOptions {
  remote?: string
  branch?: string
  /** Pull strategy; defaults to git's native merge. */
  strategy?: 'merge' | 'ff-only' | 'rebase'
}

export interface GitPushOptions {
  remote?: string
  branch?: string
}

export interface GitCloneOptions {
  ref?: string
  depth?: number
}

export interface GitMaterializeOptions {
  /** Remote URL to clone from (or update from). */
  url: string
  /** Local directory that will hold the checkout. */
  targetDir: string
  /** Branch/tag to check out after syncing the clone. */
  ref?: string
}

export interface GitMaterializeResult {
  /** True when an empty directory was cloned for the first time. */
  cloned: boolean
  /** The checked-out revision (full object id). */
  headRev: string
}

/** Default timeout for a single git subprocess (2 minutes). */
const DEFAULT_GIT_TIMEOUT_MS = 120_000

function noHooksGitEnv(): NodeJS.ProcessEnv {
  // Keep skillbox-managed sync dogfooded: disallow external git hooks from
  // running arbitrary commands in the user's environment.
  return { GIT_OPTIONAL_LOCKS: '0' }
}

/**
 * Spawns `git <args>` with `execFile` and resolves `{ exitCode: 0, ... }`.
 * Rejects on spawn failure (e.g. `ENOENT` when git is not installed) and on
 * any non-zero exit code, attaching `stdout`/`stderr` to the error.
 */
async function defaultSpawn(args: string[], options: GitSpawnOptions): Promise<GitExecResult> {
  return new Promise<GitExecResult>((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        encoding: 'utf8',
        timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        env: { ...process.env, ...noHooksGitEnv(), ...options.env },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
          return
        }
        reject(Object.assign(error, { stdout: stdout ?? '', stderr: stderr ?? '' }))
      },
    )
  })
}

/** Best-effort single-line preview of a git stderr payload for messages. */
function firstStderrLine(stderr: string): string | undefined {
  const line = stderr
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return line
}

/**
 * M2.2 Git Engine — thin wrapper around the system `git` binary. Resolves
 * remote sources on the machine's own credentials; no third-party git library
 * is pulled in.
 */
export class GitClient {
  private readonly spawn: GitSpawn
  private readonly filesystem: FilesystemService

  constructor(options: GitClientOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn
    this.filesystem = options.filesystem ?? new FilesystemService()
  }

  private async runGit(
    repositoryRoot: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<GitExecResult> {
    let result: GitExecResult
    try {
      const spawnOptions: GitSpawnOptions = { cwd: repositoryRoot }
      if (options.env !== undefined) {
        spawnOptions.env = options.env
      }
      if (options.timeoutMs !== undefined) {
        spawnOptions.timeoutMs = options.timeoutMs
      }
      result = await this.spawn(args, spawnOptions)
    } catch (error) {
      if (
        error instanceof Error &&
        typeof (error as NodeJS.ErrnoException).code === 'string' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new SkillboxError(
          ErrorCode.GIT_NOT_FOUND,
          `Git is not installed or not on PATH (needed for "git ${args.join(' ')}")`,
          { context: { command: args.join(' '), repositoryRoot } },
        )
      }
      const errno = error as Error & { code?: unknown; stdout?: string; stderr?: string }
      result = {
        exitCode: typeof errno.code === 'number' ? errno.code : 1,
        stdout: errno.stdout ?? '',
        stderr: (errno.stderr ?? '') || errno.message,
      }
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim()
      throw new SkillboxError(
        ErrorCode.GIT_COMMAND_FAILED,
        `git ${args.join(' ')} failed (exit ${result.exitCode})${
          firstStderrLine(stderr) === undefined ? '' : `: ${firstStderrLine(stderr)}`
        }`,
        {
          recoverable: true,
          context: {
            command: args.join(' '),
            repositoryRoot,
            exitCode: result.exitCode,
            stderr,
          },
          cause: new Error(stderr),
        },
      )
    }
    return result
  }

  /** `git --version`; throws `GIT_NOT_FOUND` when git is unavailable. */
  async gitVersion(repositoryRoot = process.cwd()): Promise<string> {
    const result = await this.runGit(repositoryRoot, ['--version'])
    return result.stdout.trim()
  }

  /** Whether the git binary responds on this machine. */
  async isInstalled(): Promise<boolean> {
    try {
      await this.gitVersion()
      return true
    } catch (error) {
      if (error instanceof SkillboxError && error.code === ErrorCode.GIT_NOT_FOUND) {
        return false
      }
      throw error
    }
  }

  /** `git init` — creates a new git repository at `repositoryRoot`. */
  async init(repositoryRoot: string): Promise<void> {
    await this.runGit(repositoryRoot, ['init'])
  }

  /** `git clone` — copies `url` into `targetDir` (created if missing). */
  async clone(url: string, targetDir: string, options: GitCloneOptions = {}): Promise<void> {
    const args = ['clone']
    if (options.depth !== undefined) {
      args.push('--depth', String(options.depth))
    }
    args.push(url, targetDir)
    // git clones into `targetDir`, but the subprocess cwd (`dirname`) must
    // exist before spawning or the node ENOENT is misread as a missing git.
    await this.filesystem.mkdir(path.dirname(targetDir))
    const repositoryRoot = path.dirname(targetDir)
    await this.runGit(repositoryRoot, args)
  }

  /**
   * `git status --porcelain=v1 -z` → structured file list with conflict
   * detection (`UU`/`AA`/`DD` after a failed pull/merge).
   */
  async status(repositoryRoot: string): Promise<GitStatusResult> {
    const result = await this.runGit(repositoryRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
    ])
    const files = parsePorcelainStatus(result.stdout)
    const conflicts = conflictsOf(files)
    const tracking = await this.trackingStatus(repositoryRoot)
    return {
      repositoryRoot,
      ...tracking,
      files,
      conflicts,
      hasConflicts: conflicts.length > 0,
      staged: files.filter((file) => file.staged),
      unstaged: files.filter((file) => file.unstaged),
      untracked: files.filter((file) => file.untracked),
      clean: files.length === 0,
    }
  }

  /** Branch/upstream facts used by status, pull and push orchestration. */
  private async trackingStatus(repositoryRoot: string): Promise<{
    branch?: string
    upstream?: string
    remote?: { name: string; url: string }
    ahead: number
    behind: number
  }> {
    const branch = await this.currentBranch(repositoryRoot)
    if (branch === undefined) {
      return { ahead: 0, behind: 0 }
    }
    const upstreamResult = await this.runGit(repositoryRoot, [
      'for-each-ref',
      '--format=%(upstream:short)',
      `refs/heads/${branch}`,
    ])
    const upstream = upstreamResult.stdout.trim()
    if (upstream.length === 0) {
      return { branch, ahead: 0, behind: 0 }
    }
    const separator = upstream.indexOf('/')
    const remoteName = separator > 0 ? upstream.slice(0, separator) : undefined
    const countsResult = await this.runGit(repositoryRoot, [
      'rev-list',
      '--left-right',
      '--count',
      `HEAD...${upstream}`,
    ])
    const [aheadText = '0', behindText = '0'] = countsResult.stdout.trim().split(/\s+/)
    const tracking: {
      branch: string
      upstream: string
      remote?: { name: string; url: string }
      ahead: number
      behind: number
    } = {
      branch,
      upstream,
      ahead: Number.parseInt(aheadText, 10) || 0,
      behind: Number.parseInt(behindText, 10) || 0,
    }
    if (remoteName !== undefined) {
      const url = (
        await this.runGit(repositoryRoot, ['remote', 'get-url', remoteName])
      ).stdout.trim()
      if (url.length > 0) {
        tracking.remote = { name: remoteName, url }
      }
    }
    return tracking
  }

  /**
   * `git pull [--ff-only|--rebase] [remote [branch]]`. A pull that ends in
   * conflicts exits non-zero and throws `GIT_COMMAND_FAILED`; the worktree is
   * then inspected with {@link status} to read the `UU`/`AA`/`DD` entries.
   */
  async pull(repositoryRoot: string, options: GitPullOptions = {}): Promise<void> {
    const args = ['pull']
    if (options.strategy === 'ff-only') {
      args.push('--ff-only')
    } else if (options.strategy === 'rebase') {
      args.push('--rebase')
    }
    // A bare branch (without a remote) still targets the default remote.
    if (options.branch !== undefined && options.remote === undefined) {
      args.push('origin')
    }
    if (options.remote !== undefined) {
      args.push(options.remote)
    }
    if (options.branch !== undefined) {
      args.push(options.branch)
    }
    await this.runGit(repositoryRoot, args)
  }

  /** `git push [remote [branch]]` (defaults the remote to `origin`). */
  async push(repositoryRoot: string, options: GitPushOptions = {}): Promise<void> {
    const args = ['push']
    if (options.branch !== undefined && options.remote === undefined) {
      args.push('origin')
    }
    if (options.remote !== undefined) {
      args.push(options.remote)
    }
    if (options.branch !== undefined) {
      args.push(options.branch)
    }
    await this.runGit(repositoryRoot, args)
  }

  /**
   * `git commit -m <message> [-- files...]`. When `files` is omitted the whole
   * index is committed; otherwise only the listed paths (relative to the
   * repository root) are staged into the commit.
   */
  async commit(
    repositoryRoot: string,
    message: string,
    files: readonly string[] = [],
  ): Promise<GitCommitResult> {
    const args = ['commit', '-m', message]
    if (files.length > 0) {
      args.push('--', ...files)
    }
    await this.runGit(repositoryRoot, args)
    const head = await this.revParse(repositoryRoot, 'HEAD')
    return { hash: head }
  }

  /**
   * `git diff --name-status [refA [refB]]`. Change detection between two
   * revisions (defaults to comparing the worktree against the index).
   */
  async diff(repositoryRoot: string, refA?: string, refB?: string): Promise<GitDiffResult> {
    const args = ['diff', '--name-status']
    if (refA !== undefined) {
      args.push(refA)
    }
    if (refB !== undefined) {
      args.push(refB)
    }
    const result = await this.runGit(repositoryRoot, args)
    return { files: parseNameStatus(result.stdout) }
  }

  /** `git fetch [remote]` against a specific remote (default `origin`). */
  async fetch(repositoryRoot: string, remote = 'origin'): Promise<void> {
    await this.runGit(repositoryRoot, ['fetch', '--prune', remote])
  }

  /** `git checkout <ref>` — switches the worktree to a branch/tag/commit. */
  async checkout(repositoryRoot: string, ref: string): Promise<void> {
    await this.runGit(repositoryRoot, ['checkout', ref])
  }

  /** `git rev-parse --abbrev-ref HEAD` — current branch, or `''` when detached. */
  async currentBranch(repositoryRoot: string): Promise<string | undefined> {
    const result = await this.runGit(repositoryRoot, ['branch', '--show-current'])
    const branch = result.stdout.trim()
    return branch.length > 0 ? branch : undefined
  }

  /** `git rev-parse <rev>` — full object id for a branch/tag/commit. */
  async revParse(repositoryRoot: string, rev: string): Promise<string> {
    const result = await this.runGit(repositoryRoot, ['rev-parse', rev])
    return result.stdout.trim()
  }

  /**
   * Clone-or-update semantics for reconcile: clones `url` into `targetDir`
   * when absent, otherwise fetches and fast-forwards the active branch, then
   * checks out `ref` when given. Returns the resolved `HEAD` revision.
   */
  async materialize(input: GitMaterializeOptions): Promise<GitMaterializeResult> {
    const hasGitDir = await this.filesystem.exists(path.join(input.targetDir, '.git'))
    let cloned = false
    let strategy: 'ff-only' | undefined

    if (!hasGitDir) {
      await this.clone(input.url, input.targetDir)
      cloned = true
    } else {
      await this.fetch(input.targetDir)
    }

    const current = await this.currentBranch(input.targetDir)
    if (input.ref !== undefined && current !== input.ref) {
      await this.checkout(input.targetDir, input.ref)
    } else if (current !== undefined) {
      strategy = 'ff-only'
    }

    // Fast-forward the active branch to its tracked remote when there is one.
    // Detached checkouts (tags/SHAs) skip the pull and just stay put.
    if (strategy === 'ff-only') {
      const branch = await this.currentBranch(input.targetDir)
      if (branch !== undefined) {
        await this.pull(input.targetDir, { strategy: 'ff-only' })
      }
    }

    const headRev = await this.revParse(input.targetDir, 'HEAD')
    return { cloned, headRev }
  }
}

/** Parses `git diff --name-status` output into ordered entries. */
function parseNameStatus(stdout: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '') {
      continue
    }
    const status = line.slice(0, 1)
    const rest = line.slice(1).trim()
    if (rest === '') {
      continue
    }
    const parts = rest.split('\t')
    const pathA = parts[0]
    if (pathA === undefined || pathA === '') {
      continue
    }
    const newPath = parts[1]
    if ((status === 'R' || status === 'C') && newPath !== undefined) {
      entries.push({ status, path: pathA, newPath })
    } else {
      entries.push({ status, path: pathA })
    }
  }
  return entries
}
