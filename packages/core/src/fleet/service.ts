import { ErrorCode, isSkillboxError, SkillboxError } from '../errors.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { loadFleetConfig } from './config-io.js'
import { runFleetOperation } from './orchestrator.js'
import { selectHosts } from './select.js'
import { SshClient } from './ssh-client.js'
import type {
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
    try {
      const config = await loadFleetConfig(this.configPath, this.filesystem)
      return config.hosts
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.FLEET_CONFIG_NOT_FOUND) {
        return []
      }
      throw error
    }
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
