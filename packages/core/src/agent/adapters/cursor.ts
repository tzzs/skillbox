import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const CURSOR_EXECUTABLE_ENV = 'CURSOR_BIN'
export const CURSOR_CONFIG_DIR_ENV = 'CURSOR_CONFIG_DIR'
export const CURSOR_DEFAULT_SKILLS_SUBDIR = '.cursor/skills'

const cursorCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type CursorAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * Cursor adapter (MVP_TASKS §41 M5.5). Detects the Cursor IDE through its
 * `cursor` executable or `~/.cursor/skills` (or `${CURSOR_CONFIG_DIR}/skills`),
 * scans the installed skills and links/unlinks them. All paths are derived
 * with `os.homedir()` + `node:path` and can be overridden with environment
 * variables - no hard-coded user paths.
 */
export class CursorAdapter extends CliAgentAdapter {
  readonly id = 'cursor'
  readonly name = 'Cursor'
  readonly capabilities: AgentCapabilities = cursorCapabilities

  constructor(options: CursorAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'cursor',
      executableEnv: CURSOR_EXECUTABLE_ENV,
      configDirEnv: CURSOR_CONFIG_DIR_ENV,
      defaultSkillsSubdir: CURSOR_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
