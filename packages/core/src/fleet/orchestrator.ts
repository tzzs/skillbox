import { ErrorCode, SkillboxError } from '../errors.js'
import type { SshClient } from './ssh-client.js'
import type {
  FleetHostConfig,
  FleetHostResult,
  FleetOperationName,
  FleetRunOptions,
  FleetRunResult,
} from './types.js'

const DEFAULT_CONCURRENCY = 4

/** Wraps `value` in single quotes for a POSIX remote shell, escaping embedded `'`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const OPERATION_ARGS: Record<FleetOperationName, readonly string[]> = {
  install: ['install'],
  update: ['update'],
  status: ['status', '--json'],
}

/** The exact command Fleet will run on `host` for `operation`. */
export function buildRemoteCommand(host: FleetHostConfig, operation: FleetOperationName): string {
  const bin = host.skillboxBin ?? 'skillbox'
  const command = [shellQuote(bin), ...OPERATION_ARGS[operation]].join(' ')
  return host.remotePath === undefined ? command : `cd ${shellQuote(host.remotePath)} && ${command}`
}

/**
 * Runs `operation` on every host in `hosts`, up to `options.concurrency` at
 * once (default 4). A per-host SSH/command failure is captured in that
 * host's {@link FleetHostResult} — one bad host never aborts the others.
 * Only a structural problem (no hosts, no local `ssh` binary) throws.
 */
export async function runFleetOperation(
  hosts: readonly FleetHostConfig[],
  operation: FleetOperationName,
  ssh: SshClient,
  options: FleetRunOptions = {},
): Promise<FleetRunResult> {
  if (hosts.length === 0) {
    throw new SkillboxError(
      ErrorCode.FLEET_NO_HOSTS_SELECTED,
      'No fleet hosts selected — configure .skillbox/fleet.yaml or pass --host/--tag/--ssh',
    )
  }
  if (options.dryRun !== true && !(await ssh.isInstalled())) {
    throw new SkillboxError(
      ErrorCode.FLEET_SSH_NOT_FOUND,
      'ssh is not installed or not on PATH (needed to reach fleet hosts)',
    )
  }

  const results: FleetHostResult[] = new Array(hosts.length)
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, hosts.length),
  )
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= hosts.length) {
        return
      }
      const host = hosts[index] as FleetHostConfig
      const command = buildRemoteCommand(host, operation)
      const start = Date.now()

      if (options.dryRun === true) {
        results[index] = {
          host: host.name,
          ok: true,
          exitCode: null,
          stdout: command,
          stderr: '',
          durationMs: 0,
        }
        continue
      }

      try {
        const spawnOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
        const outcome = await ssh.exec(host, command, spawnOptions)
        results[index] = {
          host: host.name,
          ok: outcome.exitCode === 0,
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          durationMs: Date.now() - start,
        }
      } catch (error) {
        if (error instanceof SkillboxError && error.code === ErrorCode.FLEET_SSH_NOT_FOUND) {
          throw error
        }
        results[index] = {
          host: host.name,
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - start,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return { operation, results }
}
