import { ClaudeAdapter } from './claude.js'
import { runCliAdapterSuite, type CliAdapterSpec } from './cli-adapter-suite.js'

const spec: CliAdapterSpec = {
  label: 'Claude Code adapter',
  defaultSkillsSubdir: '.claude/skills',
  configDirEnv: 'CLAUDE_CONFIG_DIR',
  executableEnv: 'CLAUDE_BIN',
  create: (options) => new ClaudeAdapter(options),
}

runCliAdapterSuite(spec)
