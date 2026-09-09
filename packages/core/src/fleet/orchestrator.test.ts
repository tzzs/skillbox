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
})

/** A scripted `ssh` spawn: `-V` (isInstalled) always succeeds; exec calls are dispatched per destination. */
function scriptedSpawn(
  byDestination: Record<string, Awaited<ReturnType<SshSpawn>> | (() => Promise<never>)>,
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
})
