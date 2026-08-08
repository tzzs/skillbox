import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const CODEX_EXECUTABLE_ENV = 'CODEX_BIN'
export const CODEX_CONFIG_DIR_ENV = 'CODEX_CONFIG_DIR'
export const CODEX_DEFAULT_SKILLS_SUBDIR = '.codex/skills'

const codexCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type CodexAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * Codex adapter with the same capabilities as Claude: detect `codex`, find
 * `~/.codex/skills` (or `${CODEX_CONFIG_DIR}/skills`) and manage the skills.
 */
export class CodexAdapter extends CliAgentAdapter {
  readonly id = 'codex'
  readonly name = 'Codex'
  readonly capabilities: AgentCapabilities = codexCapabilities

  constructor(options: CodexAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'codex',
      executableEnv: CODEX_EXECUTABLE_ENV,
      configDirEnv: CODEX_CONFIG_DIR_ENV,
      defaultSkillsSubdir: CODEX_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
