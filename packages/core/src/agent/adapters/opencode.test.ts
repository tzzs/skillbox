import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { OpenCodeAdapter } from './opencode.js'
import { runCliAdapterSuite, tempHome, cleanup, type CliAdapterSpec } from './cli-adapter-suite.js'

const spec: CliAdapterSpec = {
  label: 'OpenCode adapter',
  defaultSkillsSubdir: '.config/opencode/skills',
  configDirEnv: 'OPENCODE_CONFIG_DIR',
  executableEnv: 'OPENCODE_BIN',
  create: (options) => new OpenCodeAdapter(options),
}

runCliAdapterSuite(spec)

describe('OpenCode adapter fixture isolation', () => {
  it('detects through a skills directory under the fixture home only', async () => {
    const home = await tempHome('opencode-detect')
    try {
      await fs.mkdir(path.join(home, ...'.config/opencode/skills'.split('/')), { recursive: true })
      const adapter = new OpenCodeAdapter({ homeDir: home, searchPath: false })
      const result = await adapter.detect()
      expect(result.detected).toBe(true)
      expect(result.skillDirectories).toEqual([
        path.join(home, ...'.config/opencode/skills'.split('/')),
      ])
    } finally {
      await cleanup(home)
    }
  })

  it('lets OPENCODE_CONFIG_DIR override the skills location', async () => {
    const home = await tempHome('opencode-config')
    const configDir = path.join(home, 'custom-opencode')
    try {
      const adapter = new OpenCodeAdapter({
        homeDir: home,
        searchPath: false,
        env: { OPENCODE_CONFIG_DIR: configDir },
      })
      const dirs = await adapter.getSkillDirectories()
      expect(dirs).toEqual([path.join(configDir, 'skills')])
    } finally {
      await cleanup(home)
    }
  })
})
