import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { CursorAdapter } from './cursor.js'
import { runCliAdapterSuite, tempHome, type CliAdapterSpec } from './cli-adapter-suite.js'

const spec: CliAdapterSpec = {
  label: 'Cursor adapter',
  defaultSkillsSubdir: '.cursor/skills',
  configDirEnv: 'CURSOR_CONFIG_DIR',
  executableEnv: 'CURSOR_BIN',
  create: (options) => new CursorAdapter(options),
}

runCliAdapterSuite(spec)

describe('Cursor adapter fixture isolation', () => {
  it('detects through a skills directory under the fixture home only', async () => {
    const home = await tempHome('cursor-detect')
    try {
      await fs.mkdir(path.join(home, '.cursor', 'skills'), { recursive: true })
      const adapter = new CursorAdapter({ homeDir: home, searchPath: false })
      const result = await adapter.detect()
      expect(result.detected).toBe(true)
      expect(result.skillDirectories).toEqual([path.join(home, '.cursor', 'skills')])
    } finally {
      await cleanup(home)
    }
  })

  it('lets CURSOR_CONFIG_DIR override the skills location', async () => {
    const home = await tempHome('cursor-config')
    const configDir = path.join(home, 'custom-cursor')
    try {
      const adapter = new CursorAdapter({
        homeDir: home,
        searchPath: false,
        env: { CURSOR_CONFIG_DIR: configDir },
      })
      const dirs = await adapter.getSkillDirectories()
      expect(dirs).toEqual([path.join(configDir, 'skills')])
    } finally {
      await cleanup(home)
    }
  })

  it('never touches the real ~/.cursor when a fixture home is given', async () => {
    const home = await tempHome('cursor-isolated')
    try {
      const adapter = new CursorAdapter({ homeDir: home, searchPath: false })
      const result = await adapter.detect()
      expect(result.detected).toBe(false)
    } finally {
      await cleanup(home)
    }
  })
})

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}
