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

  describe('addHost', () => {
    it('creates fleet.yaml when none exists yet', async () =>
      withTempDir(async (dir) => {
        const configPath = path.join(dir, '.skillbox', 'fleet.yaml')
        const service = new FleetService({ configPath })

        const added = await service.addHost({ name: 'web-1', host: '10.0.0.11' })

        expect(added).toEqual({ name: 'web-1', host: '10.0.0.11' })
        expect((await service.listHosts()).map((host) => host.name)).toEqual(['web-1'])
      }))

    it('appends to an existing inventory', async () =>
      withTempDir(async (dir) => {
        const configPath = await writeFleetConfig(dir)
        const service = new FleetService({ configPath })

        await service.addHost({ name: 'web-3', host: '10.0.0.13' })

        expect((await service.listHosts()).map((host) => host.name)).toEqual([
          'web-1',
          'web-2',
          'web-3',
        ])
      }))

    it('rejects a duplicate name with FLEET_HOST_EXISTS', async () =>
      withTempDir(async (dir) => {
        const configPath = await writeFleetConfig(dir)
        const service = new FleetService({ configPath })

        await expect(service.addHost({ name: 'web-1', host: '10.0.0.99' })).rejects.toSatisfy(
          (error: unknown) => isSkillboxError(error) && error.code === ErrorCode.FLEET_HOST_EXISTS,
        )
      }))

    it('rejects a host that fails schema validation with FLEET_CONFIG_INVALID', async () =>
      withTempDir(async (dir) => {
        const service = new FleetService({ configPath: path.join(dir, 'fleet.yaml') })

        await expect(service.addHost({ name: '', host: '10.0.0.11' })).rejects.toSatisfy(
          (error: unknown) =>
            isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_INVALID,
        )
      }))

    it('accepts plain, IPv4 and bracketed-IPv6 hosts', async () =>
      withTempDir(async (dir) => {
        const service = new FleetService({ configPath: path.join(dir, 'fleet.yaml') })

        await expect(service.addHost({ name: 'a', host: 'web.example' })).resolves.toBeTruthy()
        await expect(service.addHost({ name: 'b', host: '[fd12::3]' })).resolves.toBeTruthy()
      }))

    it('rejects ssh-option-injection hosts and identity files', async () =>
      withTempDir(async (dir) => {
        const service = new FleetService({ configPath: path.join(dir, 'fleet.yaml') })

        await expect(
          service.addHost({ name: 'evil', host: '-oProxyCommand=touch /tmp/x' }),
        ).rejects.toSatisfy(
          (error: unknown) =>
            isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_INVALID,
        )
        await expect(
          service.addHost({
            name: 'k',
            host: 'h.example',
            identityFile: '-oStrictHostKeyChecking=no',
          }),
        ).rejects.toSatisfy(
          (error: unknown) =>
            isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_INVALID,
        )
      }))
  })

  describe('updateHost', () => {
    it('merges a patch into the existing host', async () =>
      withTempDir(async (dir) => {
        const configPath = await writeFleetConfig(dir)
        const service = new FleetService({ configPath })

        const updated = await service.updateHost('web-1', { host: '10.0.0.100' })

        expect(updated).toMatchObject({ name: 'web-1', host: '10.0.0.100', tags: ['prod'] })
        const hosts = await service.listHosts()
        expect(hosts.find((host) => host.name === 'web-1')).toMatchObject({
          host: '10.0.0.100',
        })
      }))

    it('renames a host', async () =>
      withTempDir(async (dir) => {
        const configPath = await writeFleetConfig(dir)
        const service = new FleetService({ configPath })

        await service.updateHost('web-1', { name: 'web-1-renamed' })

        expect((await service.listHosts()).map((host) => host.name)).toEqual([
          'web-1-renamed',
          'web-2',
        ])
      }))

    it('rejects a rename that collides with another host', async () =>
      withTempDir(async (dir) => {
        const configPath = await writeFleetConfig(dir)
        const service = new FleetService({ configPath })

        await expect(service.updateHost('web-1', { name: 'web-2' })).rejects.toSatisfy(
          (error: unknown) => isSkillboxError(error) && error.code === ErrorCode.FLEET_HOST_EXISTS,
        )
      }))

    it('throws FLEET_HOST_NOT_FOUND for an unknown host', async () =>
      withTempDir(async (dir) => {
        const configPath = await writeFleetConfig(dir)
        const service = new FleetService({ configPath })

        await expect(service.updateHost('ghost', { host: '1.2.3.4' })).rejects.toSatisfy(
          (error: unknown) =>
            isSkillboxError(error) && error.code === ErrorCode.FLEET_HOST_NOT_FOUND,
        )
      }))
  })

  describe('removeHost', () => {
    it('removes a configured host', async () =>
      withTempDir(async (dir) => {
        const configPath = await writeFleetConfig(dir)
        const service = new FleetService({ configPath })

        await service.removeHost('web-1')

        expect((await service.listHosts()).map((host) => host.name)).toEqual(['web-2'])
      }))

    it('throws FLEET_HOST_NOT_FOUND for an unknown host', async () =>
      withTempDir(async (dir) => {
        const configPath = await writeFleetConfig(dir)
        const service = new FleetService({ configPath })

        await expect(service.removeHost('ghost')).rejects.toSatisfy(
          (error: unknown) =>
            isSkillboxError(error) && error.code === ErrorCode.FLEET_HOST_NOT_FOUND,
        )
      }))
  })
})
