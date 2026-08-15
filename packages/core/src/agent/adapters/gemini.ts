import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const GEMINI_EXECUTABLE_ENV = 'GEMINI_BIN'
export const GEMINI_CONFIG_DIR_ENV = 'GEMINI_CONFIG_DIR'
export const GEMINI_DEFAULT_SKILLS_SUBDIR = '.gemini/skills'

const geminiCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type GeminiAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * Gemini CLI adapter (roadmap 6.3). Detects the Gemini CLI through its
 * `gemini` executable or `~/.gemini/skills` (or `${GEMINI_CONFIG_DIR}/skills`),
 * scans the installed skills and links/unlinks them. All paths are derived
 * with `os.homedir()` + `node:path` and can be overridden with environment
 * variables - no hard-coded user paths.
 */
export class GeminiAdapter extends CliAgentAdapter {
  readonly id = 'gemini'
  readonly name = 'Gemini CLI'
  readonly capabilities: AgentCapabilities = geminiCapabilities

  constructor(options: GeminiAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'gemini',
      executableEnv: GEMINI_EXECUTABLE_ENV,
      configDirEnv: GEMINI_CONFIG_DIR_ENV,
      defaultSkillsSubdir: GEMINI_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
