import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { checkSymlink, assertSymlinkInsideRoot, resolveSymlinkTarget } from './symlinks.js'
import { createDirLink, linksSupported, tempDir, cleanup } from './test-utils.js'

describe('resolveSymlinkTarget', () => {
  it.skipIf(!linksSupported)('reads a symlink target and resolves it', async () => {
    const root = await tempDir()
    try {
      const member = path.join(root, 'member')
      await fs.mkdir(member)
      const link = path.join(root, 'link')
      await createDirLink(member, link)
      const { target, resolved } = await resolveSymlinkTarget(link)
      expect(target).toBeTruthy()
      expect(resolved).toBe(member)
    } finally {
      await cleanup(root)
    }
  })
})

describe('symlink safety', () => {
  it.skipIf(!linksSupported)('keeps internal symlinks', async () => {
    const root = await tempDir()
    try {
      const member = path.join(root, 'member')
      await fs.mkdir(member)
      const link = path.join(root, 'internal')
      await createDirLink(member, link)

      const check = await checkSymlink(root, link)
      expect(check.insideRoot).toBe(true)
      await expect(assertSymlinkInsideRoot(root, link)).resolves.toMatchObject({ insideRoot: true })
    } finally {
      await cleanup(root)
    }
  })

  it.skipIf(!linksSupported)('rejects symlinks that escape the skill root', async () => {
    const root = await tempDir()
    try {
      const skillRoot = path.join(root, 'skill')
      const outside = path.join(root, 'outside')
      await fs.mkdir(skillRoot)
      await fs.mkdir(outside)
      const link = path.join(skillRoot, 'escape')
      await createDirLink(outside, link)

      const check = await checkSymlink(skillRoot, link)
      expect(check.insideRoot).toBe(false)
      await expect(assertSymlinkInsideRoot(skillRoot, link)).rejects.toMatchObject({
        code: 'UNSAFE_SYMLINK',
      })
    } finally {
      await cleanup(root)
    }
  })
})
