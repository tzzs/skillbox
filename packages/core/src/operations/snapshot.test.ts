import * as fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureSnapshot, restoreSnapshot } from './snapshot.js'
import { createDirLink, linksSupported, withTempDir } from '../fs/test-utils.js'

describe('operation snapshots', () => {
  it('restores a captured file repeatedly', async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, 'repo', 'skillbox.json')
      const storage = path.join(root, 'operations', 'one')
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, 'before')

      const snapshot = await captureSnapshot({
        targetPath: target,
        storagePath: storage,
        allowedRoots: [root],
      })
      await fs.writeFile(target, 'after')
      await restoreSnapshot({ snapshot, allowedRoots: [root] })
      expect(await fs.readFile(target, 'utf8')).toBe('before')

      await restoreSnapshot({ snapshot, allowedRoots: [root] })
      expect(await fs.readFile(target, 'utf8')).toBe('before')
    })
  })

  it('restores a missing target by removing a later directory', async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, 'repo', 'new-skill')
      const snapshot = await captureSnapshot({
        targetPath: target,
        storagePath: path.join(root, 'operations', 'two'),
        allowedRoots: [root],
      })
      await fs.mkdir(target, { recursive: true })
      await fs.writeFile(path.join(target, 'SKILL.md'), 'created later')

      await restoreSnapshot({ snapshot, allowedRoots: [root] })
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('restores a directory tree without following links', async () => {
    await withTempDir(async (root) => {
      const target = path.join(root, 'repo', 'skill')
      await fs.mkdir(path.join(target, 'nested'), { recursive: true })
      await fs.writeFile(path.join(target, 'nested', 'value.txt'), 'before')
      const snapshot = await captureSnapshot({
        targetPath: target,
        storagePath: path.join(root, 'operations', 'three'),
        allowedRoots: [root],
      })
      await fs.writeFile(path.join(target, 'nested', 'value.txt'), 'after')
      await fs.writeFile(path.join(target, 'extra.txt'), 'remove')

      await restoreSnapshot({ snapshot, allowedRoots: [root] })
      expect(await fs.readFile(path.join(target, 'nested', 'value.txt'), 'utf8')).toBe('before')
      await expect(fs.lstat(path.join(target, 'extra.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  it.skipIf(!linksSupported)('captures and restores a directory link as a link', async () => {
    await withTempDir(async (root) => {
      const linkedTarget = path.join(root, 'library', 'skill')
      const target = path.join(root, 'repo', 'skill')
      await fs.mkdir(linkedTarget, { recursive: true })
      await fs.mkdir(path.dirname(target), { recursive: true })
      await createDirLink(linkedTarget, target)
      const snapshot = await captureSnapshot({
        targetPath: target,
        storagePath: path.join(root, 'operations', 'four'),
        allowedRoots: [root],
      })
      await fs.rm(target, { recursive: true, force: true })
      await fs.mkdir(target)

      await restoreSnapshot({ snapshot, allowedRoots: [root] })
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
      expect(await fs.realpath(target)).toBe(await fs.realpath(linkedTarget))
    })
  })

  it('rejects target or storage paths outside the explicitly allowed roots', async () => {
    await withTempDir(async (root) => {
      const allowed = path.join(root, 'allowed')
      const outside = path.join(root, 'outside.txt')
      await fs.mkdir(allowed)
      await fs.writeFile(outside, 'do not touch')
      await expect(
        captureSnapshot({
          targetPath: outside,
          storagePath: path.join(allowed, 'snapshot'),
          allowedRoots: [allowed],
        }),
      ).rejects.toThrow(/allowed root/i)
    })
  })
})
