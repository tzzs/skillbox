import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { GeminiAdapter } from './gemini.js'
import { runCliAdapterSuite, tempHome, cleanup, type CliAdapterSpec } from './cli-adapter-suite.js'

const spec: CliAdapterSpec = {
  label: 'Gemini adapter',
  defaultSkillsSubdir: '.gemini/skills',
  configDirEnv: 'GEMINI_CONFIG_DIR',
  executableEnv: 'GEMINI_BIN',
  create: (options) => new GeminiAdapter(options),
}

runCliAdapterSuite(spec)

describe('Gemini adapter fixture isolation', () => {
  it('detects through a skills directory under the fixture home only', async () => {
    const home = await tempHome('gemini-detect')
    try {
      await fs.mkdir(path.join(home, '.gemini', 'skills'), { recursive: true })
      const adapter = new GeminiAdapter({ homeDir: home, searchPath: false })
      const result = await adapter.detect()
      expect(result.detected).toBe(true)
      expect(result.skillDirectories).toEqual([path.join(home, '.gemini', 'skills')])
    } finally {
      await cleanup(home)
    }
  })

  it('lets GEMINI_CONFIG_DIR override the skills location', async () => {
    const home = await tempHome('gemini-config')
    const configDir = path.join(home, 'custom-gemini')
    try {
      const adapter = new GeminiAdapter({
        homeDir: home,
        searchPath: false,
        env: { GEMINI_CONFIG_DIR: configDir },
      })
      const dirs = await adapter.getSkillDirectories()
      expect(dirs).toEqual([path.join(configDir, 'skills')])
    } finally {
      await cleanup(home)
    }
  })
})
