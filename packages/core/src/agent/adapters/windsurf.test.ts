import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { WindsurfAdapter } from './windsurf.js'
import { runCliAdapterSuite, tempHome, cleanup, type CliAdapterSpec } from './cli-adapter-suite.js'

const spec: CliAdapterSpec = {
  label: 'Windsurf adapter',
  defaultSkillsSubdir: '.windsurf/skills',
  configDirEnv: 'WINDSURF_CONFIG_DIR',
  executableEnv: 'WINDSURF_BIN',
  create: (options) => new WindsurfAdapter(options),
}

runCliAdapterSuite(spec)

describe('Windsurf adapter fixture isolation', () => {
  it('detects through a skills directory under the fixture home only', async () => {
    const home = await tempHome('windsurf-detect')
    try {
      await fs.mkdir(path.join(home, ...'.windsurf/skills'.split('/')), { recursive: true })
      const adapter = new WindsurfAdapter({ homeDir: home, searchPath: false })
      const result = await adapter.detect()
      expect(result.detected).toBe(true)
      expect(result.skillDirectories).toEqual([path.join(home, ...'.windsurf/skills'.split('/'))])
    } finally {
      await cleanup(home)
    }
  })

  it('lets WINDSURF_CONFIG_DIR override the skills location', async () => {
    const home = await tempHome('windsurf-config')
    const configDir = path.join(home, 'custom-windsurf')
    try {
      const adapter = new WindsurfAdapter({
        homeDir: home,
        searchPath: false,
        env: { WINDSURF_CONFIG_DIR: configDir },
      })
      const dirs = await adapter.getSkillDirectories()
      expect(dirs).toEqual([path.join(configDir, 'skills')])
    } finally {
      await cleanup(home)
    }
  })
})
