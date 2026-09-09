import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FleetService } from './service.js'
import { SshClient, type SshSpawn } from './ssh-client.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import { withTempDir } from '../fs/test-utils.js'

async function writeFleetConfig(dir: string): Promise<string> {
  const configPath = path.join(dir, 'fleet.yaml')
  await fs.writeFile(
    configPath,
    [
      'version: 1',
      'hosts:',
      '  - name: web-1',
      '    host: 10.0.0.11',
      '    tags: [prod]',
      '  - name: web-2',
      '    host: 10.0.0.12',
      '    tags: [staging]',
      '',
    ].join('\n'),
    'utf8',
  )
  return configPath
}

function alwaysOkSsh(): SshClient {
  const spawn: SshSpawn = async (args) =>
    args[0] === '-V'
      ? { exitCode: 0, stdout: '', stderr: '' }
      : { exitCode: 0, stdout: 'ok\n', stderr: '' }
  return new SshClient({ spawn })
}

describe('FleetService', () => {
  it('listHosts returns [] when no fleet.yaml exists yet', async () =>
    withTempDir(async (dir) => {
      const service = new FleetService({ configPath: path.join(dir, 'fleet.yaml') })
      expect(await service.listHosts()).toEqual([])
    }))

  it('listHosts returns the configured inventory', async () =>
    withTempDir(async (dir) => {
      const configPath = await writeFleetConfig(dir)
      const service = new FleetService({ configPath })
      const hosts = await service.listHosts()
      expect(hosts.map((host) => host.name)).toEqual(['web-1', 'web-2'])
    }))

  it('resolveHosts throws FLEET_CONFIG_NOT_FOUND for a name/tag selection with no config file', async () =>
    withTempDir(async (dir) => {
      const service = new FleetService({ configPath: path.join(dir, 'fleet.yaml') })
      await expect(service.resolveHosts({ hostNames: ['web-1'] })).rejects.toSatisfy(
        (error: unknown) =>
          isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_NOT_FOUND,
      )
    }))

  it('resolveHosts allows a purely ad-hoc selection with no config file', async () =>
    withTempDir(async (dir) => {
      const service = new FleetService({ configPath: path.join(dir, 'fleet.yaml') })
      const hosts = await service.resolveHosts({ adHoc: [{ name: 'x', host: '1.2.3.4' }] })
      expect(hosts).toEqual([{ name: 'x', host: '1.2.3.4' }])
    }))

  it('run resolves the selector and executes across the matched hosts', async () =>
    withTempDir(async (dir) => {
      const configPath = await writeFleetConfig(dir)
      const service = new FleetService({ configPath, ssh: alwaysOkSsh() })

      const result = await service.run('status', { tags: ['prod'] })

      expect(result.operation).toBe('status')
      expect(result.results).toHaveLength(1)
      expect(result.results[0]).toMatchObject({ host: 'web-1', ok: true })
    }))
})
