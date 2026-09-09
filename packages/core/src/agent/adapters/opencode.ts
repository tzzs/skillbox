import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const OPENCODE_BIN = 'OPENCODE_BIN'
export const OPENCODE_CONFIG_DIR = 'OPENCODE_CONFIG_DIR'
export const OPENCODE_DEFAULT_SKILLS_SUBDIR = '.config/opencode/skills'

const opencodeCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type OpenCodeAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * OpenCode adapter (roadmap 6.3). Detects the OpenCode CLI through its
 * `opencode` executable or `~/.config/opencode/skills` (override via
 * `OPENCODE_CONFIG_DIR`), scans the installed skills and links/unlinks them. All
 * paths derive from `os.homedir()` + `node:path` with environment overrides.
 */
export class OpenCodeAdapter extends CliAgentAdapter {
  readonly id = 'opencode'
  readonly name = 'OpenCode'
  readonly capabilities: AgentCapabilities = opencodeCapabilities

  constructor(options: OpenCodeAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'opencode',
      executableEnv: OPENCODE_BIN,
      configDirEnv: OPENCODE_CONFIG_DIR,
      defaultSkillsSubdir: OPENCODE_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
