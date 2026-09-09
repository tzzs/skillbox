import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const COPILOT_BIN = 'COPILOT_BIN'
export const COPILOT_CONFIG_DIR = 'COPILOT_CONFIG_DIR'
export const COPILOT_DEFAULT_SKILLS_SUBDIR = '.copilot/skills'

const copilotCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type CopilotAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * GitHub Copilot adapter (roadmap 6.3). Detects the GitHub Copilot CLI through its
 * `copilot` executable or `~/.copilot/skills` (override via
 * `COPILOT_CONFIG_DIR`), scans the installed skills and links/unlinks them. All
 * paths derive from `os.homedir()` + `node:path` with environment overrides.
 */
export class CopilotAdapter extends CliAgentAdapter {
  readonly id = 'copilot'
  readonly name = 'GitHub Copilot'
  readonly capabilities: AgentCapabilities = copilotCapabilities

  constructor(options: CopilotAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'copilot',
      executableEnv: COPILOT_BIN,
      configDirEnv: COPILOT_CONFIG_DIR,
      defaultSkillsSubdir: COPILOT_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
