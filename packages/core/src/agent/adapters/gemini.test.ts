import { GeminiAdapter } from './gemini.js'
import { runAgentConformanceSuite, type AgentConformanceSpec } from './agent-conformance-suite.js'

const spec: AgentConformanceSpec = {
  label: 'Gemini CLI adapter',
  defaultSkillsSubdir: '.gemini/skills',
  configDirEnv: 'GEMINI_CONFIG_DIR',
  executableEnv: 'GEMINI_BIN',
  create: (options) => new GeminiAdapter(options),
}

runAgentConformanceSuite(spec)
