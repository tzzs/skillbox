import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { CopilotAdapter } from './copilot.js'
import { runCliAdapterSuite, tempHome, cleanup, type CliAdapterSpec } from './cli-adapter-suite.js'

const spec: CliAdapterSpec = {
  label: 'GitHub Copilot adapter',
  defaultSkillsSubdir: '.copilot/skills',
  configDirEnv: 'COPILOT_CONFIG_DIR',
  executableEnv: 'COPILOT_BIN',
  create: (options) => new CopilotAdapter(options),
}

runCliAdapterSuite(spec)

describe('GitHub Copilot adapter fixture isolation', () => {
  it('detects through a skills directory under the fixture home only', async () => {
    const home = await tempHome('copilot-detect')
    try {
      await fs.mkdir(path.join(home, ...'.copilot/skills'.split('/')), { recursive: true })
      const adapter = new CopilotAdapter({ homeDir: home, searchPath: false })
      const result = await adapter.detect()
      expect(result.detected).toBe(true)
      expect(result.skillDirectories).toEqual([path.join(home, ...'.copilot/skills'.split('/'))])
    } finally {
      await cleanup(home)
    }
  })

  it('lets COPILOT_CONFIG_DIR override the skills location', async () => {
    const home = await tempHome('copilot-config')
    const configDir = path.join(home, 'custom-copilot')
    try {
      const adapter = new CopilotAdapter({
        homeDir: home,
        searchPath: false,
        env: { COPILOT_CONFIG_DIR: configDir },
      })
      const dirs = await adapter.getSkillDirectories()
      expect(dirs).toEqual([path.join(configDir, 'skills')])
    } finally {
      await cleanup(home)
    }
  })
})
