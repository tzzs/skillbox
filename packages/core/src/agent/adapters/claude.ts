import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const CLAUDE_EXECUTABLE_ENV = 'CLAUDE_BIN'
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'
export const CLAUDE_DEFAULT_SKILLS_SUBDIR = '.claude/skills'

const claudeCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type ClaudeCodeAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * Claude Code adapter. Detects the `claude` CLI, locates
 * `~/.claude/skills` (or `${CLAUDE_CONFIG_DIR}/skills`), scans the installed
 * skills and links/unlinks them - never through hard-coded user paths.
 */
export class ClaudeAdapter extends CliAgentAdapter {
  readonly id = 'claude'
  readonly name = 'Claude'
  readonly capabilities: AgentCapabilities = claudeCapabilities

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'claude',
      executableEnv: CLAUDE_EXECUTABLE_ENV,
      configDirEnv: CLAUDE_CONFIG_DIR_ENV,
      defaultSkillsSubdir: CLAUDE_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
