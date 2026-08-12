import { describe, expect, it } from 'vitest'
import { WindsurfAdapter } from './windsurf.js'
import { runAgentConformanceSuite, type AgentConformanceSpec } from './agent-conformance-suite.js'

const spec: AgentConformanceSpec = {
  label: 'Windsurf adapter',
  defaultSkillsSubdir: '.codeium/windsurf/skills',
  configDirEnv: 'WINDSURF_CONFIG_DIR',
  executableEnv: 'WINDSURF_BIN',
  create: (options) => new WindsurfAdapter(options),
}

runAgentConformanceSuite(spec)

describe('Windsurf adapter capabilities', () => {
  it('declares both documented global and workspace skill support', () => {
    const adapter = new WindsurfAdapter({ searchPath: false })
    expect(adapter.capabilities).toMatchObject({
      supportsGlobalSkills: true,
      supportsProjectSkills: true,
      supportsSymlinks: true,
    })
  })
})
