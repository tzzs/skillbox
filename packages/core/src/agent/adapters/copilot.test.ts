import { CopilotAdapter } from './copilot.js'
import { runAgentConformanceSuite, type AgentConformanceSpec } from './agent-conformance-suite.js'

const spec: AgentConformanceSpec = {
  label: 'GitHub Copilot CLI adapter',
  defaultSkillsSubdir: '.copilot/skills',
  configDirEnv: 'COPILOT_CONFIG_DIR',
  executableEnv: 'COPILOT_BIN',
  create: (options) => new CopilotAdapter(options),
}

runAgentConformanceSuite(spec)
