import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillTreeMergeService } from './skill-tree-merge.js'

const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-tree-'))
  roots.push(root)
  const result = {
    base: path.join(root, 'base'),
    local: path.join(root, 'local'),
    remote: path.join(root, 'remote'),
    output: path.join(root, 'output'),
  }
  await Promise.all(Object.values(result).map((dir) => fs.mkdir(dir, { recursive: true })))
  return result
}
async function write(root: string, relative: string, text: string) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, text)
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('SkillTreeMergeService', () => {
  it('combines independent file changes without modifying inputs', async () => {
    const f = await fixture()
    await Promise.all([
      write(f.base, 'SKILL.md', 'base'),
      write(f.base, 'notes.md', 'base'),
      write(f.local, 'SKILL.md', 'local'),
      write(f.local, 'notes.md', 'base'),
      write(f.remote, 'SKILL.md', 'base'),
      write(f.remote, 'notes.md', 'remote'),
    ])
    const result = await new SkillTreeMergeService().merge({
      baseRoot: f.base,
      localRoot: f.local,
      remoteRoot: f.remote,
      outputRoot: f.output,
      skillAlias: 'demo',
    })
    expect(result.conflicts).toEqual([])
    await expect(fs.readFile(path.join(f.output, 'SKILL.md'), 'utf8')).resolves.toBe('local')
    await expect(fs.readFile(path.join(f.output, 'notes.md'), 'utf8')).resolves.toBe('remote')
  })
  it('returns a safe conflict instead of writing markers for competing file changes', async () => {
    const f = await fixture()
    await Promise.all([
      write(f.base, 'SKILL.md', 'base'),
      write(f.local, 'SKILL.md', 'local'),
      write(f.remote, 'SKILL.md', 'remote'),
    ])
    const result = await new SkillTreeMergeService().merge({
      baseRoot: f.base,
      localRoot: f.local,
      remoteRoot: f.remote,
      outputRoot: f.output,
      skillAlias: 'demo',
    })
    expect(result.conflicts).toMatchObject([{ type: 'content', path: 'SKILL.md' }])
    await expect(fs.stat(path.join(f.output, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
