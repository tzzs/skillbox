import { ErrorCode, isSkillboxError, SkillboxError } from '../errors.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { loadFleetConfig, saveFleetConfig } from './config-io.js'
import { runFleetOperation } from './orchestrator.js'
import { selectHosts } from './select.js'
import { fleetHostConfigSchema } from './schema.js'
import { SshClient } from './ssh-client.js'
import type {
  FleetConfig,
  FleetHostConfig,
  FleetHostSelector,
  FleetOperationName,
  FleetRunOptions,
  FleetRunResult,
} from './types.js'

export interface FleetServiceOptions {
  /** Path to `.skillbox/fleet.yaml`, e.g. `path.join(repositoryRoot, '.skillbox', 'fleet.yaml')`. */
  configPath: string
  ssh?: SshClient
  filesystem?: FilesystemService
}

/**
 * Fleet — orchestrates `skillbox install` / `update` / `status` across
 * remote hosts over SSH. The single entry point CLI `fleet` commands and the
 * Web `/api/fleet/*` routes both call into, so listing/selecting/running
 * hosts behaves identically from either surface.
 */
export class FleetService {
  private readonly configPath: string
  private readonly ssh: SshClient
  private readonly filesystem: FilesystemService

  constructor(options: FleetServiceOptions) {
    this.configPath = options.configPath
    this.ssh = options.ssh ?? new SshClient()
    this.filesystem = options.filesystem ?? new FilesystemService()
  }

  /** Configured hosts from `fleet.yaml`; `[]` when no config file exists yet. */
  async listHosts(): Promise<FleetHostConfig[]> {
    const config = await this.loadOrEmptyConfig()
    return config.hosts
  }

  private async loadOrEmptyConfig(): Promise<FleetConfig> {
    try {
      return await loadFleetConfig(this.configPath, this.filesystem)
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_NOT_FOUND) {
        return { version: 1, hosts: [] }
      }
      throw error
    }
  }

  /** Validates a candidate host, wrapping a schema failure as `FLEET_CONFIG_INVALID`. */
  private parseHost(host: unknown): FleetHostConfig {
    const result = fleetHostConfigSchema.safeParse(host)
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }))
      throw new SkillboxError(
        ErrorCode.FLEET_CONFIG_INVALID,
        'Fleet host failed schema validation',
        {
          context: { issues },
        },
      )
    }
    return result.data
  }

  /**
   * Adds a host to `fleet.yaml`, creating the file if it doesn't exist yet.
   * Throws `FLEET_HOST_EXISTS` for a name that's already configured, and
   * `FLEET_CONFIG_INVALID` for a host that fails schema validation.
   */
  async addHost(host: FleetHostConfig): Promise<FleetHostConfig> {
    const validated = this.parseHost(host)
    const config = await this.loadOrEmptyConfig()
    if (config.hosts.some((existing) => existing.name === validated.name)) {
      throw new SkillboxError(
        ErrorCode.FLEET_HOST_EXISTS,
        `A fleet host named "${validated.name}" already exists`,
        { context: { name: validated.name } },
      )
    }
    const next: FleetConfig = { ...config, hosts: [...config.hosts, validated] }
    await saveFleetConfig(this.configPath, next, this.filesystem)
    return validated
  }

  /**
   * Merges `patch` into the host named `name` and persists the result.
   * `patch.name` renames the host, and throws `FLEET_HOST_EXISTS` if the new
   * name collides with a different host. Throws `FLEET_HOST_NOT_FOUND` when
   * `name` isn't configured.
   */
  async updateHost(name: string, patch: Partial<FleetHostConfig>): Promise<FleetHostConfig> {
    const config = await this.loadOrEmptyConfig()
    const index = config.hosts.findIndex((existing) => existing.name === name)
    if (index === -1) {
      throw new SkillboxError(ErrorCode.FLEET_HOST_NOT_FOUND, `No fleet host named "${name}"`, {
        context: { name },
      })
    }
    const current = config.hosts[index] as FleetHostConfig
    const merged = this.parseHost({ ...current, ...patch })
    if (
      merged.name !== current.name &&
      config.hosts.some((existing) => existing.name === merged.name)
    ) {
      throw new SkillboxError(
        ErrorCode.FLEET_HOST_EXISTS,
        `A fleet host named "${merged.name}" already exists`,
        { context: { name: merged.name } },
      )
    }
    const hosts = [...config.hosts]
    hosts[index] = merged
    await saveFleetConfig(this.configPath, { ...config, hosts }, this.filesystem)
    return merged
  }

  /** Removes the host named `name` from `fleet.yaml`. Throws `FLEET_HOST_NOT_FOUND` if it isn't there. */
  async removeHost(name: string): Promise<void> {
    const config = await this.loadOrEmptyConfig()
    if (!config.hosts.some((existing) => existing.name === name)) {
      throw new SkillboxError(ErrorCode.FLEET_HOST_NOT_FOUND, `No fleet host named "${name}"`, {
        context: { name },
      })
    }
    const hosts = config.hosts.filter((existing) => existing.name !== name)
    await saveFleetConfig(this.configPath, { ...config, hosts }, this.filesystem)
  }

  /**
   * Resolves a selector to concrete hosts. A selector naming hosts/tags (or
   * left empty, defaulting to the whole inventory) requires `fleet.yaml` to
   * exist and throws `FLEET_CONFIG_NOT_FOUND` otherwise; a purely ad-hoc
   * `--ssh` selector never needs the config file.
   */
  async resolveHosts(selector: FleetHostSelector = {}): Promise<FleetHostConfig[]> {
    const isPureAdHoc =
      selector.hostNames === undefined &&
      selector.tags === undefined &&
      (selector.adHoc?.length ?? 0) > 0
    let hosts: readonly FleetHostConfig[] = []
    try {
      hosts = (await loadFleetConfig(this.configPath, this.filesystem)).hosts
    } catch (error) {
      if (!isSkillboxError(error) || error.code !== ErrorCode.FLEET_CONFIG_NOT_FOUND) {
        throw error
      }
      if (!isPureAdHoc) {
        throw new SkillboxError(
          ErrorCode.FLEET_CONFIG_NOT_FOUND,
          `No fleet.yaml found at "${this.configPath}" — create it, or select hosts with --ssh only`,
          { context: { path: this.configPath } },
        )
      }
    }
    return selectHosts({ hosts }, selector)
  }

  /** Resolves `selector`, then runs `operation` on every matched host. */
  async run(
    operation: FleetOperationName,
    selector: FleetHostSelector = {},
    options: FleetRunOptions = {},
  ): Promise<FleetRunResult> {
    const hosts = await this.resolveHosts(selector)
    return runFleetOperation(hosts, operation, this.ssh, options)
  }
}
