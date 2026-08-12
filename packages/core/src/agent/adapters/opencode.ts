import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const OPENCODE_EXECUTABLE_ENV = 'OPENCODE_BIN'
export const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_CONFIG_DIR'
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
 * OpenCode adapter. OpenCode discovers global skills from
 * `~/.config/opencode/skills` and accepts `OPENCODE_CONFIG_DIR` as its
 * configuration-directory override. Project-local `.opencode/skills` are
 * discovered relative to an OpenCode working directory, which this
 * user-global adapter intentionally does not manage.
 *
 * `OPENCODE_BIN` is a Skillbox test/deployment seam for selecting the CLI
 * executable; it is separate from OpenCode's own configuration environment.
 * See https://opencode.ai/docs/skills and https://opencode.ai/docs/config.
 */
export class OpenCodeAdapter extends CliAgentAdapter {
  readonly id = 'opencode'
  readonly name = 'OpenCode'
  readonly capabilities: AgentCapabilities = opencodeCapabilities

  constructor(options: OpenCodeAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'opencode',
      executableEnv: OPENCODE_EXECUTABLE_ENV,
      configDirEnv: OPENCODE_CONFIG_DIR_ENV,
      defaultSkillsSubdir: OPENCODE_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
