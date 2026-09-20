import { ErrorCode, SkillboxError } from '../errors.js'
import type { SshClient } from './ssh-client.js'
import type {
  FleetHostConfig,
  FleetHostResult,
  FleetOperationName,
  FleetRunOptions,
  FleetRunResult,
  FleetSkillTarget,
} from './types.js'

const DEFAULT_CONCURRENCY = 4

/** Wraps `value` in single quotes for a POSIX remote shell, escaping embedded `'`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function requireTarget(operation: FleetOperationName, target?: FleetSkillTarget): FleetSkillTarget {
  if (target === undefined) {
    throw new SkillboxError(
      ErrorCode.FLEET_TARGET_REQUIRED,
      `Fleet "${operation}" needs a skill to target`,
      { context: { operation } },
    )
  }
  return target
}

function requireAgent(operation: FleetOperationName, target: FleetSkillTarget): string {
  if (target.agent === undefined) {
    throw new SkillboxError(
      ErrorCode.FLEET_TARGET_REQUIRED,
      `Fleet "${operation}" needs an agent to target`,
      { context: { operation, name: target.name } },
    )
  }
  return target.agent
}

const OPERATION_ARGS: Record<FleetOperationName, (target?: FleetSkillTarget) => readonly string[]> =
  {
    install: () => ['install'],
    status: () => ['status', '--json'],
    // Bare `update` refreshes every outdated managed skill; a target narrows
    // it to just that one (see packages/cli/src/program.ts's `update <name>`
    // and bare `update` commands).
    update: (target) =>
      target === undefined
        ? ['update']
        : ['update', target.name, ...(target.yes === true ? ['--yes'] : [])],
    remove: (target) => {
      const t = requireTarget('remove', target)
      return ['remove', t.name, ...(t.deleteFiles === true ? ['--delete-files'] : [])]
    },
    enable: (target) => {
      const t = requireTarget('enable', target)
      return ['enable', t.name, '--agent', requireAgent('enable', t)]
    },
    disable: (target) => {
      const t = requireTarget('disable', target)
      return ['disable', t.name, '--agent', requireAgent('disable', t)]
    },
    // Routes through the recoverable multi-device sync engine, not the
    // legacy git-sync pipeline `install`/`update`/`status` otherwise share —
    // the host must already be `skillbox connect`-ed (Tier 2: reuses the
    // Tier 3 engine instead of a parallel local/remote diff mechanism).
    sync: () => ['sync', '--multi-device'],
    // Connectivity probe: reach the host and run the shell's no-op. Proves
    // ssh + authentication work without requiring skillbox on the remote.
    ping: () => ['true'],
  }

/** The exact command Fleet will run on `host` for `operation`. */
export function buildRemoteCommand(
  host: FleetHostConfig,
  operation: FleetOperationName,
  target?: FleetSkillTarget,
): string {
  const bin = host.skillboxBin ?? 'skillbox'
  if (operation === 'ping') {
    return host.remotePath === undefined ? 'true' : `cd ${shellQuote(host.remotePath)} && true`
  }
  const args = OPERATION_ARGS[operation](target).map((arg, index) =>
    // Only quote the skill/agent names the caller supplied — the flags
    // (`install`, `--agent`, `--delete-files`, ...) are our own literals.
    index === 0 || arg.startsWith('--') ? arg : shellQuote(arg),
  )
  const command = [shellQuote(bin), ...args].join(' ')
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
  // Validate the target once upfront — otherwise every host's worker would
  // independently discover and report the exact same missing-target error.
  if (operation === 'remove' || operation === 'enable' || operation === 'disable') {
    const target = requireTarget(operation, options.target)
    if (operation !== 'remove') {
      requireAgent(operation, target)
    }
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
      const command = buildRemoteCommand(host, operation, options.target)
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
        const retries = Math.max(0, options.retries ?? 0)
        let outcome = await ssh.exec(host, command, spawnOptions)
        let attempt = 0
        // Exit code 255 is ssh's own "connection failed" signal (and null
        // means the process was killed/timed out) — both are transient, so
        // the host gets re-tried before being declared failed. A non-zero
        // remote command exit is a real result and never retries.
        while (attempt < retries && (outcome.exitCode === 255 || outcome.exitCode === null)) {
          attempt += 1
          if (options.sleepBeforeRetry !== undefined) {
            await options.sleepBeforeRetry(attempt)
          }
          outcome = await ssh.exec(host, command, spawnOptions)
        }
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
