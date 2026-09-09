import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { ErrorCode, SkillboxError } from '../errors.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { REDACTED } from '../logging/redact.js'
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

/** Process-scoped authentication applied to exactly one Git transport invocation. */
export interface GitTransportAuth {
  prefixArgs: readonly string[]
  env: Readonly<NodeJS.ProcessEnv>
  sensitiveEnvKeys: readonly string[]
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
  auth?: GitTransportAuth
}

export interface GitPushOptions {
  remote?: string
  branch?: string
  /** Establish branch tracking on the first push. */
  setUpstream?: boolean
  auth?: GitTransportAuth
}

export interface GitCloneOptions {
  ref?: string
  depth?: number
  auth?: GitTransportAuth
}

export interface GitMaterializeOptions {
  /** Remote URL to clone from (or update from). */
  url: string
  /** Local directory that will hold the checkout. */
  targetDir: string
  /** Branch/tag to check out after syncing the clone. */
  ref?: string
  auth?: GitTransportAuth
}

export interface GitMaterializeResult {
  /** True when an empty directory was cloned for the first time. */
  cloned: boolean
  /** The checked-out revision (full object id). */
  headRev: string
}

/** A file read from an immutable Git tree. Paths are always repository-relative. */
export interface GitTreeFile {
  path: string
  content: Uint8Array
}

function authOptions(auth: GitTransportAuth | undefined): { auth?: GitTransportAuth } {
  return auth === undefined ? {} : { auth }
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
    options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; auth?: GitTransportAuth } = {},
  ): Promise<GitExecResult> {
    const invocationArgs = [...(options.auth?.prefixArgs ?? []), ...args]
    const sensitiveValues = (options.auth?.sensitiveEnvKeys ?? [])
      .map((key) => options.auth?.env[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    const redact = (value: string): string =>
      sensitiveValues.reduce((current, sensitive) => current.replaceAll(sensitive, REDACTED), value)
    let result: GitExecResult
    try {
      const spawnOptions: GitSpawnOptions = { cwd: repositoryRoot }
      if (options.env !== undefined || options.auth !== undefined) {
        spawnOptions.env = { ...options.env, ...options.auth?.env }
      }
      if (options.timeoutMs !== undefined) {
        spawnOptions.timeoutMs = options.timeoutMs
      }
      result = await this.spawn(invocationArgs, spawnOptions)
    } catch (error) {
      if (
        error instanceof Error &&
        typeof (error as NodeJS.ErrnoException).code === 'string' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new SkillboxError(
          ErrorCode.GIT_NOT_FOUND,
          `Git is not installed or not on PATH (needed for "git ${invocationArgs.join(' ')}")`,
          { context: { command: redact(invocationArgs.join(' ')), repositoryRoot } },
        )
      }
      const errno = error as Error & { code?: unknown; stdout?: string; stderr?: string }
      result = {
        exitCode: typeof errno.code === 'number' ? errno.code : 1,
        stdout: redact(errno.stdout ?? ''),
        stderr: redact((errno.stderr ?? '') || errno.message),
      }
    }

    result = { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim()
      throw new SkillboxError(
        ErrorCode.GIT_COMMAND_FAILED,
        `git ${redact(invocationArgs.join(' '))} failed (exit ${result.exitCode})${
          firstStderrLine(stderr) === undefined ? '' : `: ${firstStderrLine(stderr)}`
        }`,
        {
          recoverable: true,
          context: {
            command: redact(invocationArgs.join(' ')),
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

  /**
   * `git ls-remote <url> <ref>` — resolves a remote ref name (branch / tag /
   * `HEAD`) to its object id without cloning. Returns `undefined` when the
   * ref does not exist on the remote.
   */
  async lsRemote(
    url: string,
    ref = 'HEAD',
    options: { auth?: GitTransportAuth } = {},
  ): Promise<string | undefined> {
    const result = await this.runGit(
      process.cwd(),
      ['ls-remote', url, ref],
      authOptions(options.auth),
    )
    const first = result.stdout.trim().split(/\s+/)[0]
    return first === undefined || first === '' ? undefined : first
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

  /** Whether `repositoryRoot` is inside a Git working tree. */
  async isRepository(repositoryRoot: string): Promise<boolean> {
    try {
      const result = await this.runGit(repositoryRoot, ['rev-parse', '--is-inside-work-tree'])
      return result.stdout.trim() === 'true'
    } catch (error) {
      if (error instanceof SkillboxError && error.code === ErrorCode.GIT_COMMAND_FAILED) {
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
    await this.runGit(repositoryRoot, args, authOptions(options.auth))
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
    const configuredRemote = await this.configuredRemote(repositoryRoot)
    const branch = await this.currentBranch(repositoryRoot)
    if (branch === undefined) {
      return {
        ...(configuredRemote === undefined ? {} : { remote: configuredRemote }),
        ahead: 0,
        behind: 0,
      }
    }
    const upstreamResult = await this.runGit(repositoryRoot, [
      'for-each-ref',
      '--format=%(upstream:short)',
      `refs/heads/${branch}`,
    ])
    const upstream = upstreamResult.stdout.trim()
    if (upstream.length === 0) {
      return {
        branch,
        ...(configuredRemote === undefined ? {} : { remote: configuredRemote }),
        ahead: 0,
        behind: 0,
      }
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

  /** Prefers origin, otherwise reports the sole configured remote. */
  private async configuredRemote(
    repositoryRoot: string,
  ): Promise<{ name: string; url: string } | undefined> {
    const remotes = (await this.runGit(repositoryRoot, ['remote'])).stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    const name = remotes.includes('origin')
      ? 'origin'
      : remotes.length === 1
        ? remotes[0]
        : undefined
    if (name === undefined) {
      return undefined
    }
    const url = (await this.runGit(repositoryRoot, ['remote', 'get-url', name])).stdout.trim()
    return url.length === 0 ? undefined : { name, url }
  }

  /** Returns a named remote when configured. */
  async getRemote(
    repositoryRoot: string,
    name: string,
  ): Promise<{ name: string; url: string } | undefined> {
    const remotes = (await this.runGit(repositoryRoot, ['remote'])).stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
    if (!remotes.includes(name)) {
      return undefined
    }
    const url = (await this.runGit(repositoryRoot, ['remote', 'get-url', name])).stdout.trim()
    return url.length === 0 ? undefined : { name, url }
  }

  /** Adds a named remote. Callers inspect conflicts with {@link getRemote}. */
  async addRemote(repositoryRoot: string, name: string, url: string): Promise<void> {
    await this.runGit(repositoryRoot, ['remote', 'add', name, url])
  }

  /** Removes a named remote; an already-absent remote is a no-op. */
  async removeRemote(repositoryRoot: string, name: string): Promise<void> {
    if ((await this.getRemote(repositoryRoot, name)) !== undefined) {
      await this.runGit(repositoryRoot, ['remote', 'remove', name])
    }
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
    await this.runGit(repositoryRoot, args, authOptions(options.auth))
  }

  /** `git push [remote [branch]]` (defaults the remote to `origin`). */
  async push(repositoryRoot: string, options: GitPushOptions = {}): Promise<void> {
    const args = ['push']
    if (options.setUpstream === true) {
      args.push('--set-upstream')
    }
    if (options.branch !== undefined && options.remote === undefined) {
      args.push('origin')
    }
    if (options.remote !== undefined) {
      args.push(options.remote)
    }
    if (options.branch !== undefined) {
      args.push(options.branch)
    }
    try {
      await this.runGit(repositoryRoot, args, authOptions(options.auth))
    } catch (error) {
      if (error instanceof SkillboxError && error.code === ErrorCode.GIT_COMMAND_FAILED) {
        const stderr = String(error.context?.stderr ?? '').toLowerCase()
        if (
          stderr.includes('authentication failed') ||
          stderr.includes('could not read username') ||
          stderr.includes('invalid username or password')
        ) {
          throw new SkillboxError(ErrorCode.GIT_AUTH_FAILED, 'Git remote authentication failed', {
            cause: error,
            recoverable: true,
            context: { phase: 'push', stderr: error.context?.stderr },
          })
        }
        if (stderr.includes('non-fast-forward') || stderr.includes('rejected')) {
          throw new SkillboxError(
            ErrorCode.GIT_PUSH_REJECTED,
            'Git push was rejected; local commits were preserved',
            {
              cause: error,
              recoverable: true,
              context: { phase: 'push', stderr: error.context?.stderr },
            },
          )
        }
      }
      throw error
    }
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
    if (files.length > 0) {
      await this.runGit(repositoryRoot, ['add', '-A', '--', ...files])
    }
    const args = ['commit', '-m', message]
    if (files.length > 0) {
      args.push('--', ...files)
    }
    await this.runGit(repositoryRoot, args)
    const head = await this.revParse(repositoryRoot, 'HEAD')
    return { hash: head }
  }

  /** Stages only repository-relative managed paths for a later commit. */
  async stage(repositoryRoot: string, files: readonly string[]): Promise<void> {
    await this.runGit(repositoryRoot, ['add', '-A', '--', ...files])
  }

  /** Records the remote parent while leaving the semantic transaction to stage managed files. */
  async beginSemanticMerge(repositoryRoot: string, otherRevision: string): Promise<void> {
    await this.runGit(repositoryRoot, [
      'merge',
      '--no-commit',
      '--no-ff',
      '-s',
      'ours',
      otherRevision,
    ])
  }

  async abortMerge(repositoryRoot: string): Promise<void> {
    await this.runGit(repositoryRoot, ['merge', '--abort'])
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
  async fetch(repositoryRoot: string, remote = 'origin', auth?: GitTransportAuth): Promise<void> {
    await this.runGit(repositoryRoot, ['fetch', '--prune', remote], authOptions(auth))
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

  /** Returns the merge base of two validated revisions. */
  async mergeBase(repositoryRoot: string, left: string, right: string): Promise<string> {
    const result = await this.runGit(repositoryRoot, ['merge-base', left, right])
    return result.stdout.trim()
  }

  /** Reads a single repository-relative file from an immutable revision. */
  async readFileAtRevision(
    repositoryRoot: string,
    revision: string,
    relativePath: string,
  ): Promise<Uint8Array> {
    const normalized = relativePath.replaceAll('\\', '/')
    if (
      normalized.length === 0 ||
      normalized.startsWith('/') ||
      normalized.split('/').includes('..')
    ) {
      throw new SkillboxError(ErrorCode.UNSAFE_PATH, 'Git tree path must be repository-relative', {
        context: { relativePath },
      })
    }
    const result = await this.runGit(repositoryRoot, ['show', `${revision}:${normalized}`])
    return Buffer.from(result.stdout, 'utf8')
  }

  /** Lists regular files in an immutable revision without checking it out. */
  async listFilesAtRevision(repositoryRoot: string, revision: string): Promise<string[]> {
    const result = await this.runGit(repositoryRoot, ['ls-tree', '-r', '--name-only', revision])
    return result.stdout.split(/\r?\n/).filter((entry) => entry.length > 0)
  }

  /** Creates a private Skillbox ref that retains a revision for recovery. */
  async createPrivateRef(repositoryRoot: string, name: string, revision: string): Promise<void> {
    if (!/^refs\/skillbox\/[a-z0-9/_-]+$/i.test(name)) {
      throw new SkillboxError(ErrorCode.UNSAFE_PATH, 'Private ref must be under refs/skillbox', {
        context: { name },
      })
    }
    await this.runGit(repositoryRoot, ['update-ref', name, revision])
  }

  async deletePrivateRef(repositoryRoot: string, name: string): Promise<void> {
    if (!/^refs\/skillbox\/[a-z0-9/_-]+$/i.test(name)) {
      throw new SkillboxError(ErrorCode.UNSAFE_PATH, 'Private ref must be under refs/skillbox', {
        context: { name },
      })
    }
    await this.runGit(repositoryRoot, ['update-ref', '-d', name])
  }

  /** Materializes an immutable revision into an isolated linked worktree. */
  async createWorktree(repositoryRoot: string, targetDir: string, revision: string): Promise<void> {
    await this.filesystem.mkdir(path.dirname(targetDir))
    await this.runGit(repositoryRoot, [
      'worktree',
      'add',
      '--detach',
      '--force',
      targetDir,
      revision,
    ])
  }

  async removeWorktree(repositoryRoot: string, targetDir: string): Promise<void> {
    await this.runGit(repositoryRoot, ['worktree', 'remove', '--force', targetDir])
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
      await this.clone(input.url, input.targetDir, authOptions(input.auth))
      cloned = true
    } else {
      await this.fetch(input.targetDir, 'origin', input.auth)
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
        await this.pull(input.targetDir, { strategy: 'ff-only', ...authOptions(input.auth) })
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
