import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const COPILOT_EXECUTABLE_ENV = 'COPILOT_BIN'
export const COPILOT_CONFIG_DIR_ENV = 'COPILOT_CONFIG_DIR'
export const COPILOT_DEFAULT_SKILLS_SUBDIR = '.copilot/skills'

const copilotCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: true,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type CopilotAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * GitHub Copilot CLI adapter. Copilot discovers personal skills from
 * `~/.copilot/skills`; project skills are discovered from `.github/skills`,
 * `.claude/skills`, or `.agents/skills` by the host and are deliberately not
 * mutated by this user-level adapter. `COPILOT_CONFIG_DIR` provides a portable
 * configuration-root override and `COPILOT_BIN` is Skillbox's executable seam.
 */
export class CopilotAdapter extends CliAgentAdapter {
  readonly id = 'copilot'
  readonly name = 'GitHub Copilot'
  readonly capabilities: AgentCapabilities = copilotCapabilities

  constructor(options: CopilotAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'copilot',
      executableEnv: COPILOT_EXECUTABLE_ENV,
      configDirEnv: COPILOT_CONFIG_DIR_ENV,
      defaultSkillsSubdir: COPILOT_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
