import { describe, expect, it } from 'vitest'
import { SshClient, type SshSpawn } from './ssh-client.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import type { FleetHostConfig } from './types.js'

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
}

describe('SshClient', () => {
  it('builds args from host fields and reports the remote exit code', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn: SshSpawn = async (args) => {
      calls.push({ args })
      return { exitCode: 0, stdout: 'ok\n', stderr: '' }
    }
    const client = new SshClient({ spawn })
    const host: FleetHostConfig = {
      name: 'web-1',
      host: '10.0.0.11',
      user: 'deploy',
      port: 2222,
      identityFile: '~/.ssh/id_ed25519',
    }

    const result = await client.exec(host, 'skillbox status --json')

    expect(calls[0]?.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-p',
      '2222',
      '-i',
      '~/.ssh/id_ed25519',
      'deploy@10.0.0.11',
      'skillbox status --json',
    ])
    expect(result).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' })
  })

  it('omits user/port/identityFile args when unset', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn: SshSpawn = async (args) => {
      calls.push({ args })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const client = new SshClient({ spawn })

    await client.exec({ name: 'bare', host: '10.0.0.5' }, 'skillbox update')

    expect(calls[0]?.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '10.0.0.5',
      'skillbox update',
    ])
  })

  it('returns a non-zero result instead of throwing on a remote command failure', async () => {
    const spawn: SshSpawn = async () => {
      throw Object.assign(new Error('Command failed'), {
        code: 1,
        stdout: '',
        stderr: 'skillbox: command not found\n',
      })
    }
    const client = new SshClient({ spawn })

    const result = await client.exec({ name: 'web-1', host: '10.0.0.11' }, 'skillbox update')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('command not found')
  })

  it('throws FLEET_SSH_NOT_FOUND when the local ssh binary is missing', async () => {
    const spawn: SshSpawn = async () => {
      throw enoent()
    }
    const client = new SshClient({ spawn })

    await expect(
      client.exec({ name: 'web-1', host: '10.0.0.11' }, 'skillbox update'),
    ).rejects.toSatisfy(
      (error: unknown) => isSkillboxError(error) && error.code === ErrorCode.FLEET_SSH_NOT_FOUND,
    )
  })

  describe('isInstalled', () => {
    it('is true when ssh -V responds', async () => {
      const client = new SshClient({
        spawn: async () => ({ exitCode: 0, stdout: '', stderr: 'OpenSSH_9.0\n' }),
      })
      expect(await client.isInstalled()).toBe(true)
    })

    it('is false when the binary is missing (ENOENT)', async () => {
      const client = new SshClient({
        spawn: async () => {
          throw enoent()
        },
      })
      expect(await client.isInstalled()).toBe(false)
    })
  })
})
