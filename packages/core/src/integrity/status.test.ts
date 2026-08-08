import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { computeSkillIntegrity } from './canonical-hash.js'
import { compareIntegrity, detectLocalModification } from './status.js'

describe('compareIntegrity', () => {
  it('returns ready when the hashes match', () => {
    expect(compareIntegrity('sha256:abc', 'sha256:abc')).toBe('ready')
  })

  it('returns modified when the hashes differ', () => {
    expect(compareIntegrity('sha256:abc', 'sha256:def')).toBe('modified')
  })
})

describe('detectLocalModification', () => {
  it('returns ready when the skill matches its locked integrity', async () => {
    await withTempDir(async (dir) => {
      const skill = path.join(dir, 'skill')
      await fs.mkdir(skill)
      await fs.writeFile(path.join(skill, 'SKILL.md'), '# demo\n', 'utf8')

      const locked = await computeSkillIntegrity(skill)
      expect(await detectLocalModification(skill, locked)).toBe('ready')
    })
  })

  it('returns modified after SKILL.md changes', async () => {
    await withTempDir(async (dir) => {
      const skill = path.join(dir, 'skill')
      await fs.mkdir(skill)
      await fs.writeFile(path.join(skill, 'SKILL.md'), '# demo\n', 'utf8')

      const locked = await computeSkillIntegrity(skill)
      await fs.writeFile(path.join(skill, 'SKILL.md'), '# demo — edited\n', 'utf8')
      expect(await detectLocalModification(skill, locked)).toBe('modified')
    })
  })

  it('returns modified when a file is added after locking', async () => {
    await withTempDir(async (dir) => {
      const skill = path.join(dir, 'skill')
      await fs.mkdir(skill)
      await fs.writeFile(path.join(skill, 'SKILL.md'), 'x\n', 'utf8')

      const locked = await computeSkillIntegrity(skill)
      await fs.writeFile(path.join(skill, 'extra.txt'), 'y\n', 'utf8')
      expect(await detectLocalModification(skill, locked)).toBe('modified')
    })
  })
})
