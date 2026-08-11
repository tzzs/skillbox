import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { validateSkillDirectory } from './validator.js'
import { createDirLink, linksSupported, tempDir, cleanup } from './test-utils.js'

async function createValidSkill(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true })
  await fs.mkdir(path.join(root, 'references'), { recursive: true })
  await fs.mkdir(path.join(root, 'assets'), { recursive: true })
  await fs.writeFile(path.join(root, 'SKILL.md'), '# Skill\n')
  await fs.writeFile(path.join(root, 'scripts', 'run.js'), '// 1')
  await fs.writeFile(path.join(root, 'references', 'doc.md'), 'ref')
  await fs.writeFile(path.join(root, 'assets', 'icon.png'), '')
}

describe('validateSkillDirectory', () => {
  it('accepts a valid skill layout', async () => {
    const root = await tempDir()
    try {
      await createValidSkill(root)
      const result = await validateSkillDirectory(root)
      expect(result.skillMdPath).toBe(path.join(root, 'SKILL.md'))
    } finally {
      await cleanup(root)
    }
  })

  it('accepts a lowercase skill.md file name', async () => {
    const root = await tempDir()
    try {
      await fs.writeFile(path.join(root, 'skill.md'), '# x')
      const result = await validateSkillDirectory(root)
      expect(result.skillMdPath).toBe(path.join(root, 'skill.md'))
    } finally {
      await cleanup(root)
    }
  })

  it('rejects a directory without SKILL.md as INVALID_SKILL', async () => {
    const root = await tempDir()
    try {
      await fs.writeFile(path.join(root, 'README.md'), '# no skill')
      await expect(validateSkillDirectory(root)).rejects.toMatchObject({ code: 'INVALID_SKILL' })
    } finally {
      await cleanup(root)
    }
  })

  it('rejects an empty directory as INVALID_SKILL', async () => {
    const root = await tempDir()
    try {
      await expect(validateSkillDirectory(root)).rejects.toMatchObject({ code: 'INVALID_SKILL' })
    } finally {
      await cleanup(root)
    }
  })

  it.skipIf(!linksSupported)('rejects a skill with an escaping symlink', async () => {
    const root = await tempDir()
    try {
      const skillRoot = path.join(root, 'skill')
      const outside = path.join(root, 'outside')
      await fs.mkdir(skillRoot, { recursive: true })
      await fs.mkdir(outside, { recursive: true })
      await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '# x')
      await createDirLink(outside, path.join(skillRoot, 'escape'))
      await expect(validateSkillDirectory(skillRoot)).rejects.toMatchObject({
        code: 'UNSAFE_SYMLINK',
      })
    } finally {
      await cleanup(root)
    }
  })
})
