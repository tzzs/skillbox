import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { BackupService } from '../backup/index.js'
import { SkillService } from './skill-service.js'

describe('SkillService.removeSkill with unified backups', () => {
  it('records runtime + repo-dir backups and rollback restores the deleted files', async () => {
    await withTempDir(async (dir) => {
      const repositoryRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repositoryRoot, { recursive: true })
      const skills = new SkillService({ repositoryRoot, homeRoot })

      await skills.createSkill({ name: 'hello', description: 'demo' })
      await expect(
        fs.readFile(path.join(repositoryRoot, 'skills', 'hello', 'SKILL.md'), 'utf8'),
      ).resolves.toContain('# hello')

      // Remove with --delete-files: the repo dir + library copy are destroyed.
      const removed = await skills.removeSkill({ name: 'hello', deleteFiles: true })
      expect(removed.filesRemoved).toBe(true)
      await expect(fs.stat(path.join(repositoryRoot, 'skills', 'hello'))).rejects.toThrow()

      // The unified backup index holds both captured pieces.
      const backups = new BackupService({ homeRoot })
      const records = await backups.list()
      expect(records.map((record) => record.kind).sort()).toEqual(['repo-dir', 'runtime'])
      expect(records.every((record) => record.operation === 'remove')).toBe(true)
      expect(records.every((record) => record.alias === 'hello')).toBe(true)

      // Rolling back the repo-dir backup restores the deleted skill files.
      const repoDir = records.find((record) => record.kind === 'repo-dir')
      expect(repoDir).toBeDefined()
      const result = await backups.rollback(repoDir?.id ?? '', { repositoryRoot })
      expect(result.filesRestored).toBeGreaterThan(0)
      await expect(
        fs.readFile(path.join(repositoryRoot, 'skills', 'hello', 'SKILL.md'), 'utf8'),
      ).resolves.toContain('# hello')
    })
  })
})
