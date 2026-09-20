import { describe, expect, it } from 'vitest'
import { buildRemoteCommand, runFleetOperation } from './orchestrator.js'
import { SshClient, type SshSpawn } from './ssh-client.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import type { FleetHostConfig } from './types.js'

describe('buildRemoteCommand', () => {
  it('quotes the default binary and appends the operation args', () => {
    expect(buildRemoteCommand({ name: 'h', host: '1.2.3.4' }, 'install')).toBe("'skillbox' install")
    expect(buildRemoteCommand({ name: 'h', host: '1.2.3.4' }, 'update')).toBe("'skillbox' update")
    expect(buildRemoteCommand({ name: 'h', host: '1.2.3.4' }, 'status')).toBe(
      "'skillbox' status --json",
    )
  })

  it('prefixes a cd into remotePath when set', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4', remotePath: '/srv/skills' }
    expect(buildRemoteCommand(host, 'install')).toBe("cd '/srv/skills' && 'skillbox' install")
  })

  it('honors a custom skillboxBin and escapes embedded quotes', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4', skillboxBin: "/opt/skill'box/bin" }
    expect(buildRemoteCommand(host, 'update')).toBe("'/opt/skill'\\''box/bin' update")
  })

  it('targets a single skill for update, quoting the name but not the flag', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4' }
    expect(buildRemoteCommand(host, 'update', { name: 'incident-runbook' })).toBe(
      "'skillbox' update 'incident-runbook'",
    )
    expect(buildRemoteCommand(host, 'update', { name: 'incident-runbook', yes: true })).toBe(
      "'skillbox' update 'incident-runbook' --yes",
    )
  })

  it('builds remove, quoting the name and passing --delete-files through', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4' }
    expect(buildRemoteCommand(host, 'remove', { name: 'legacy-deploy' })).toBe(
      "'skillbox' remove 'legacy-deploy'",
    )
    expect(buildRemoteCommand(host, 'remove', { name: 'legacy-deploy', deleteFiles: true })).toBe(
      "'skillbox' remove 'legacy-deploy' --delete-files",
    )
  })

  it('builds enable/disable, quoting both the name and the agent', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4' }
    expect(buildRemoteCommand(host, 'enable', { name: 'incident-runbook', agent: 'claude' })).toBe(
      "'skillbox' enable 'incident-runbook' --agent 'claude'",
    )
    expect(buildRemoteCommand(host, 'disable', { name: 'incident-runbook', agent: 'claude' })).toBe(
      "'skillbox' disable 'incident-runbook' --agent 'claude'",
    )
  })

  it('builds sync through the multi-device engine, with no target needed', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4' }
    expect(buildRemoteCommand(host, 'sync')).toBe("'skillbox' sync --multi-device")
  })

  it('builds ping as a bare no-op without touching skillbox', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4' }
    expect(buildRemoteCommand(host, 'ping')).toBe('true')
    const withPath: FleetHostConfig = { name: 'h', host: '1.2.3.4', remotePath: '/srv/skills' }
    expect(buildRemoteCommand(withPath, 'ping')).toBe("cd '/srv/skills' && true")
  })

  it('throws FLEET_TARGET_REQUIRED for remove/enable/disable without a target', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4' }
    for (const operation of ['remove', 'enable', 'disable'] as const) {
      try {
        buildRemoteCommand(host, operation)
        expect.unreachable(`buildRemoteCommand should have thrown for "${operation}"`)
      } catch (error) {
        expect(isSkillboxError(error) && error.code === ErrorCode.FLEET_TARGET_REQUIRED).toBe(true)
      }
    }
  })

  it('throws FLEET_TARGET_REQUIRED for enable/disable without an agent', () => {
    const host: FleetHostConfig = { name: 'h', host: '1.2.3.4' }
    for (const operation of ['enable', 'disable'] as const) {
      expect(() => buildRemoteCommand(host, operation, { name: 'x' })).toThrowError()
    }
  })
})

/** A scripted `ssh` spawn: `-V` (isInstalled) always succeeds; exec calls are dispatched per destination. */
function scriptedSpawn(
  byDestination: Record<
    string,
    Awaited<ReturnType<SshSpawn>> | (() => Awaited<ReturnType<SshSpawn>>)
  >,
): { spawn: SshSpawn; calls: string[][] } {
  const calls: string[][] = []
  const spawn: SshSpawn = async (args) => {
    calls.push(args)
    if (args[0] === '-V') {
      return { exitCode: 0, stdout: '', stderr: 'OpenSSH_9.0\n' }
    }
    const destination = args.at(-2) as string
    const outcome = byDestination[destination]
    if (typeof outcome === 'function') {
      return outcome()
    }
    if (outcome === undefined) {
      throw new Error(`no scripted outcome for ${destination}`)
    }
    return outcome
  }
  return { spawn, calls }
}

const hostA: FleetHostConfig = { name: 'a', host: 'a.example' }
const hostB: FleetHostConfig = { name: 'b', host: 'b.example' }
const hostC: FleetHostConfig = { name: 'c', host: 'c.example' }

describe('runFleetOperation', () => {
  it('throws FLEET_NO_HOSTS_SELECTED for an empty host list', async () => {
    const ssh = new SshClient({ spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })
    await expect(runFleetOperation([], 'install', ssh)).rejects.toSatisfy(
      (error: unknown) =>
        isSkillboxError(error) && error.code === ErrorCode.FLEET_NO_HOSTS_SELECTED,
    )
  })

  it('throws FLEET_SSH_NOT_FOUND when ssh is not installed locally', async () => {
    const ssh = new SshClient({
      spawn: async () => {
        throw Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
      },
    })
    await expect(runFleetOperation([hostA], 'install', ssh)).rejects.toSatisfy(
      (error: unknown) => isSkillboxError(error) && error.code === ErrorCode.FLEET_SSH_NOT_FOUND,
    )
  })

  it('runs every host and captures per-host success/failure without aborting the batch', async () => {
    const { spawn } = scriptedSpawn({
      'a.example': { exitCode: 0, stdout: 'a ok\n', stderr: '' },
      'b.example': { exitCode: 1, stdout: '', stderr: 'b failed\n' },
      'c.example': () => {
        throw Object.assign(new Error('connection refused'), { code: 255, stdout: '', stderr: '' })
      },
    })
    const ssh = new SshClient({ spawn })

    const result = await runFleetOperation([hostA, hostB, hostC], 'update', ssh)

    expect(result.operation).toBe('update')
    const byHost = Object.fromEntries(result.results.map((entry) => [entry.host, entry]))
    expect(byHost.a).toMatchObject({ ok: true, exitCode: 0, stdout: 'a ok\n' })
    expect(byHost.b).toMatchObject({ ok: false, exitCode: 1, stderr: 'b failed\n' })
    expect(byHost.c?.ok).toBe(false)
  })

  it('never runs more than `concurrency` hosts at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const spawn: SshSpawn = async (args) => {
      if (args[0] === '-V') {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const ssh = new SshClient({ spawn })
    const hosts = Array.from({ length: 6 }, (_, index) => ({
      name: `h${index}`,
      host: `h${index}.example`,
    }))

    await runFleetOperation(hosts, 'status', ssh, { concurrency: 2 })

    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('dry-run reports the would-be command without invoking ssh', async () => {
    const { spawn, calls } = scriptedSpawn({})
    const ssh = new SshClient({ spawn })

    const result = await runFleetOperation([hostA], 'install', ssh, { dryRun: true })

    expect(calls).toHaveLength(0)
    expect(result.results[0]).toMatchObject({ ok: true, stdout: "'skillbox' install" })
  })

  it('retries connection failures (exit 255) up to `retries` times', async () => {
    let attempts = 0
    const { spawn, calls } = scriptedSpawn({
      'a.example': () => {
        attempts += 1
        if (attempts < 3) {
          return { exitCode: 255, stdout: '', stderr: 'connection refused' }
        }
        return { exitCode: 0, stdout: 'recovered\n', stderr: '' }
      },
    })
    const ssh = new SshClient({ spawn })
    const sleeps: number[] = []

    const result = await runFleetOperation([hostA], 'install', ssh, {
      retries: 2,
      sleepBeforeRetry: async (attempt) => {
        sleeps.push(attempt)
      },
    })

    expect(result.results[0]).toMatchObject({ ok: true, stdout: 'recovered\n' })
    expect(calls.filter((args) => args[0] !== '-V')).toHaveLength(3)
    expect(sleeps).toEqual([1, 2])
  })

  it('gives up after `retries` and never retries a real remote exit code', async () => {
    const { spawn, calls } = scriptedSpawn({
      'a.example': { exitCode: 255, stdout: '', stderr: 'still down' },
      'b.example': { exitCode: 1, stdout: '', stderr: 'command failed' },
    })
    const ssh = new SshClient({ spawn })

    const result = await runFleetOperation([hostA, hostB], 'install', ssh, {
      retries: 1,
      sleepBeforeRetry: async () => {},
    })

    const byHost = Object.fromEntries(result.results.map((entry) => [entry.host, entry]))
    expect(byHost.a?.ok).toBe(false)
    expect(byHost.b).toMatchObject({ ok: false, exitCode: 1 })
    const execs = calls.filter((args) => args[0] !== '-V')
    expect(execs.filter((args) => args.includes('a.example'))).toHaveLength(2)
    expect(execs.filter((args) => args.includes('b.example'))).toHaveLength(1)
  })
})
