import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode, SkillboxError } from '../errors.js'
import { RepositoryValidator } from './repository-validator.js'

const roots: string[] = []
async function fixture(valid = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-validate-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'skills', 'demo'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'skillbox.yaml'),
    'version: 1\nskills:\n  demo:\n    source:\n      type: local\n      path: skills/demo\n',
  )
  if (valid) await fs.writeFile(path.join(root, 'skills', 'demo', 'SKILL.md'), '# Demo\n')
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
describe('RepositoryValidator', () => {
  it('accepts a valid isolated repository and returns canonical yaml', async () => {
    const root = await fixture()
    const result = await new RepositoryValidator().validate(root)
    expect(result.manifestYaml).toContain('version: 1')
  })
  it('rejects a skill missing SKILL.md without writing the repository', async () => {
    const root = await fixture(false)
    await expect(new RepositoryValidator().validate(root)).rejects.toMatchObject({
      code: ErrorCode.SYNC_VALIDATION_FAILED,
    } satisfies Partial<SkillboxError>)
    await expect(fs.readFile(path.join(root, 'skillbox.yaml'), 'utf8')).resolves.toContain(
      'version: 1',
    )
  })
})
