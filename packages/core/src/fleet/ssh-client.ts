import { execFile } from 'node:child_process'
import { ErrorCode, SkillboxError } from '../errors.js'
import type { FleetHostConfig } from './types.js'

/** Result of one spawned `ssh` process. */
export interface SshExecResult {
  /** Remote process exit code; `null` when ssh itself was killed/timed out. */
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface SshSpawnOptions {
  timeoutMs?: number
}

/**
 * Injectable process runner used by {@link SshClient}. Tests swap this for a
 * fake to simulate a missing `ssh` binary or scripted per-host outcomes.
 */
export type SshSpawn = (args: string[], options: SshSpawnOptions) => Promise<SshExecResult>

export interface SshClientOptions {
  /** Process runner; defaults to `execFile('ssh', ...)`. */
  spawn?: SshSpawn
}

/** Default timeout for a single ssh subprocess (2 minutes). */
const DEFAULT_SSH_TIMEOUT_MS = 120_000

async function defaultSpawn(args: string[], options: SshSpawnOptions): Promise<SshExecResult> {
  return new Promise<SshExecResult>((resolve, reject) => {
    execFile(
      'ssh',
      args,
      { encoding: 'utf8', timeout: options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS },
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

function destination(host: FleetHostConfig): string {
  return host.user === undefined ? host.host : `${host.user}@${host.host}`
}

/**
 * Thin wrapper around the system `ssh` binary. No third-party SSH library is
 * pulled in — remote hosts authenticate however the local `ssh` client (and
 * `~/.ssh/config`) is already set up to authenticate them.
 */
export class SshClient {
  private readonly spawn: SshSpawn

  constructor(options: SshClientOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn
  }

  /** Whether the `ssh` binary responds on this (control) machine. */
  async isInstalled(): Promise<boolean> {
    try {
      await this.spawn(['-V'], {})
      return true
    } catch (error) {
      if (
        error instanceof Error &&
        typeof (error as NodeJS.ErrnoException).code === 'string' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return false
      }
      // `ssh -V` prints the version to stderr and exits non-zero on some
      // builds; any response (including a rejected non-ENOENT error) means
      // the binary is present and ran.
      return true
    }
  }

  /**
   * Runs `remoteCommand` on `host` via `ssh` and resolves with its outcome.
   * `BatchMode=yes` disables interactive prompts (missing/mismatched keys
   * fail fast instead of hanging); a short `ConnectTimeout` bounds unreachable
   * hosts. Throws `FLEET_SSH_NOT_FOUND` when the local `ssh` binary is
   * missing; any other spawn/non-zero outcome is returned, never thrown, so
   * callers can report a per-host failure without aborting the whole run.
   */
  async exec(
    host: FleetHostConfig,
    remoteCommand: string,
    options: SshSpawnOptions = {},
  ): Promise<SshExecResult> {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
    if (host.port !== undefined) {
      args.push('-p', String(host.port))
    }
    if (host.identityFile !== undefined) {
      args.push('-i', host.identityFile)
    }
    args.push(destination(host), remoteCommand)

    try {
      return await this.spawn(args, options)
    } catch (error) {
      if (
        error instanceof Error &&
        typeof (error as NodeJS.ErrnoException).code === 'string' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new SkillboxError(
          ErrorCode.FLEET_SSH_NOT_FOUND,
          'ssh is not installed or not on PATH (needed to reach fleet hosts)',
          { context: { host: host.name } },
        )
      }
      const errno = error as Error & { code?: unknown; stdout?: string; stderr?: string }
      return {
        exitCode: typeof errno.code === 'number' ? errno.code : null,
        stdout: errno.stdout ?? '',
        stderr: (errno.stderr ?? '') || errno.message,
      }
    }
  }
}
