import { OpenCodeAdapter } from './opencode.js'
import { runAgentConformanceSuite, type AgentConformanceSpec } from './agent-conformance-suite.js'

const spec: AgentConformanceSpec = {
  label: 'OpenCode adapter',
  defaultSkillsSubdir: '.config/opencode/skills',
  configDirEnv: 'OPENCODE_CONFIG_DIR',
  executableEnv: 'OPENCODE_BIN',
  // The local developer environment may set OPENCODE_CONFIG_DIR for its own
  // hooks. Keep conformance fixtures hermetic unless a test supplies env.
  create: (options) => new OpenCodeAdapter({ ...options, env: options.env ?? {} }),
}

runAgentConformanceSuite(spec)
