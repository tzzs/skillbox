import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withTempDir } from '../fs/test-utils.js'
import { createOperationRuntime } from '../operations/runtime.js'
import { SkillService } from './skill-service.js'

describe('SkillService.createSkill', () => {
  it('records every created repository and runtime target for user rollback', async () => {
    await withTempDir(async (root) => {
      const repositoryRoot = path.join(root, 'repository')
      const homeRoot = path.join(root, 'home')
      await fs.mkdir(repositoryRoot, { recursive: true })
      const runtime = createOperationRuntime({ repositoryRoot, homeRoot })
      const service = new SkillService({ repositoryRoot, homeRoot, operationRuntime: runtime })

      await service.createSkill({ name: 'hello', description: 'A rollback test.' })
      await expect(
        fs.readFile(path.join(repositoryRoot, 'skills', 'hello', 'SKILL.md'), 'utf8'),
      ).resolves.toContain('A rollback test.')

      await expect(runtime.rollback()).resolves.toMatchObject({
        restoredTargets: expect.arrayContaining([
          path.join(repositoryRoot, 'skills', 'hello'),
          path.join(repositoryRoot, 'skillbox.yaml'),
          path.join(repositoryRoot, 'skillbox.lock'),
        ]),
      })
      await expect(fs.stat(path.join(repositoryRoot, 'skills', 'hello'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(fs.stat(path.join(repositoryRoot, 'skillbox.yaml'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })
})
