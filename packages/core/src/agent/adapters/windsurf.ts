import type { AgentCapabilities } from '../../domain/agent.js'
import { CliAgentAdapter, type CliAgentAdapterConfig } from '../adapter.js'

export const WINDSURF_EXECUTABLE_ENV = 'WINDSURF_BIN'
export const WINDSURF_CONFIG_DIR_ENV = 'WINDSURF_CONFIG_DIR'
export const WINDSURF_DEFAULT_SKILLS_SUBDIR = '.codeium/windsurf/skills'

const windsurfCapabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: true,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

export type WindsurfAdapterOptions = Omit<
  CliAgentAdapterConfig,
  'executableName' | 'configDirEnv' | 'defaultSkillsSubdir' | 'executableEnv'
>

/**
 * Windsurf Cascade adapter. Windsurf discovers global skills at
 * `~/.codeium/windsurf/skills` and project skills at `.windsurf/skills`.
 * Skillbox manages the global location; `WINDSURF_CONFIG_DIR` overrides the
 * `~/.codeium/windsurf` base directory for portable installs and tests.
 */
export class WindsurfAdapter extends CliAgentAdapter {
  readonly id = 'windsurf'
  readonly name = 'Windsurf'
  readonly capabilities: AgentCapabilities = windsurfCapabilities

  constructor(options: WindsurfAdapterOptions = {}) {
    super({
      ...options,
      executableName: 'windsurf',
      executableEnv: WINDSURF_EXECUTABLE_ENV,
      configDirEnv: WINDSURF_CONFIG_DIR_ENV,
      defaultSkillsSubdir: WINDSURF_DEFAULT_SKILLS_SUBDIR,
    })
  }
}
