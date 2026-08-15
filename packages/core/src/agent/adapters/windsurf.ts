import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const WINDSURF_BIN = 'WINDSURF_BIN'
export const WINDSURF_CONFIG_DIR = 'WINDSURF_CONFIG_DIR'
export const WINDSURF_DEFAULT_SKILLS_SUBDIR = '.windsurf/skills'

const windsurfCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type WindsurfAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * Windsurf adapter (roadmap 6.3). Detects the Windsurf CLI through its
 * `windsurf` executable or `~/.windsurf/skills` (override via
 * `WINDSURF_CONFIG_DIR`), scans the installed skills and links/unlinks them. All
 * paths derive from `os.homedir()` + `node:path` with environment overrides.
 */
export class WindsurfAdapter extends CliAgentAdapter {
  readonly id = 'windsurf'
  readonly name = 'Windsurf'
  readonly capabilities: AgentCapabilities = windsurfCapabilities

  constructor(options: WindsurfAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'windsurf',
      executableEnv: WINDSURF_BIN,
      configDirEnv: WINDSURF_CONFIG_DIR,
      defaultSkillsSubdir: WINDSURF_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
