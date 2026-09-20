import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SkillboxManifest } from '../manifest/index.js'
import { LockResolver } from './lock-resolver.js'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
it('rebuilds a stable lockfile from merged manifest and content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-lock-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'skills', 'demo'), { recursive: true })
  await fs.writeFile(path.join(root, 'skills', 'demo', 'SKILL.md'), '# Demo\n')
  const manifest: SkillboxManifest = {
    version: 1,
    skills: { demo: { source: { type: 'local', path: 'skills/demo' } } },
  }
  const resolver = new LockResolver()
  const one = await resolver.resolve(manifest, root)
  const two = await resolver.resolve(manifest, root)
  expect(one).toEqual(two)
  expect(one.skills.demo?.integrity).toMatch(/^sha256:/)
})
