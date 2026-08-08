import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import {
  DEFAULT_GIT_ATTRIBUTES,
  GIT_ATTRIBUTES_FILE_NAME,
  ensureGitAttributes,
} from './gitattributes.js'

describe('DEFAULT_GIT_ATTRIBUTES', () => {
  it('forces LF for text files', () => {
    expect(DEFAULT_GIT_ATTRIBUTES).toContain('* text=auto eol=lf')
  })

  it('marks common binary extensions', () => {
    expect(DEFAULT_GIT_ATTRIBUTES).toContain('*.png binary')
    expect(DEFAULT_GIT_ATTRIBUTES).toContain('*.pdf binary')
    expect(DEFAULT_GIT_ATTRIBUTES).toContain('*.zip binary')
  })
})

describe('ensureGitAttributes', () => {
  it('creates the fixture when missing', async () => {
    await withTempDir(async (dir) => {
      await ensureGitAttributes(dir)
      expect(await fs.readFile(path.join(dir, GIT_ATTRIBUTES_FILE_NAME), 'utf8')).toBe(
        DEFAULT_GIT_ATTRIBUTES,
      )
    })
  })

  it('never overwrites an existing .gitattributes', async () => {
    await withTempDir(async (dir) => {
      const custom = '*.md text eol=crlf\n'
      await fs.writeFile(path.join(dir, GIT_ATTRIBUTES_FILE_NAME), custom, 'utf8')
      await ensureGitAttributes(dir)
      expect(await fs.readFile(path.join(dir, GIT_ATTRIBUTES_FILE_NAME), 'utf8')).toBe(custom)
    })
  })
})
