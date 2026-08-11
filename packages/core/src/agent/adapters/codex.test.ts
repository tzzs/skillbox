import { CodexAdapter } from './codex.js'
import { runCliAdapterSuite, type CliAdapterSpec } from './cli-adapter-suite.js'

const spec: CliAdapterSpec = {
  label: 'Codex adapter',
  defaultSkillsSubdir: '.codex/skills',
  configDirEnv: 'CODEX_CONFIG_DIR',
  executableEnv: 'CODEX_BIN',
  create: (options) => new CodexAdapter(options),
}

runCliAdapterSuite(spec)
