import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { loadFleetConfig } from './config-io.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import { withTempDir } from '../fs/test-utils.js'

describe('loadFleetConfig', () => {
  it('throws FLEET_CONFIG_NOT_FOUND when the file is missing', async () =>
    withTempDir(async (dir) => {
      const configPath = path.join(dir, 'fleet.yaml')
      await expect(loadFleetConfig(configPath)).rejects.toSatisfy(
        (error: unknown) =>
          isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_NOT_FOUND,
      )
    }))

  it('parses a valid inventory', async () =>
    withTempDir(async (dir) => {
      const configPath = path.join(dir, 'fleet.yaml')
      await fs.writeFile(
        configPath,
        [
          'version: 1',
          'hosts:',
          '  - name: web-1',
          '    host: 10.0.0.11',
          '    user: deploy',
          '    port: 2222',
          '    identityFile: ~/.ssh/id_ed25519',
          '    remotePath: /srv/skillbox-repo',
          '    tags: [prod, web]',
          '  - name: web-2',
          '    host: 10.0.0.12',
          '',
        ].join('\n'),
        'utf8',
      )

      const config = await loadFleetConfig(configPath)
      expect(config.hosts).toHaveLength(2)
      expect(config.hosts[0]).toMatchObject({
        name: 'web-1',
        host: '10.0.0.11',
        user: 'deploy',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
        remotePath: '/srv/skillbox-repo',
        tags: ['prod', 'web'],
      })
      expect(config.hosts[1]).toMatchObject({ name: 'web-2', host: '10.0.0.12' })
    }))

  it('throws FLEET_CONFIG_INVALID for malformed YAML', async () =>
    withTempDir(async (dir) => {
      const configPath = path.join(dir, 'fleet.yaml')
      await fs.writeFile(configPath, 'hosts: [unterminated', 'utf8')
      await expect(loadFleetConfig(configPath)).rejects.toSatisfy(
        (error: unknown) => isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_INVALID,
      )
    }))

  it('throws FLEET_CONFIG_INVALID for a schema violation', async () =>
    withTempDir(async (dir) => {
      const configPath = path.join(dir, 'fleet.yaml')
      await fs.writeFile(configPath, 'version: 1\nhosts:\n  - name: web-1\n', 'utf8')
      await expect(loadFleetConfig(configPath)).rejects.toSatisfy(
        (error: unknown) => isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_INVALID,
      )
    }))

  it('throws FLEET_CONFIG_INVALID for duplicate host names', async () =>
    withTempDir(async (dir) => {
      const configPath = path.join(dir, 'fleet.yaml')
      await fs.writeFile(
        configPath,
        'version: 1\nhosts:\n  - name: web-1\n    host: 10.0.0.11\n  - name: web-1\n    host: 10.0.0.12\n',
        'utf8',
      )
      await expect(loadFleetConfig(configPath)).rejects.toSatisfy(
        (error: unknown) => isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_INVALID,
      )
    }))
})
