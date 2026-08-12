import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { FilesystemService } from './filesystem-service.js'
import { withTempDir } from './test-utils.js'

const service = new FilesystemService()

describe('FilesystemService', () => {
  it('reports existence and missing paths', async () => {
    await withTempDir(async (dir) => {
      expect(await service.exists(dir)).toBe(true)
      expect(await service.exists(path.join(dir, 'nope'))).toBe(false)
    })
  })

  it('writes and reads back a file', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'config.json')
      await service.writeFile(file, '{"a":1}')
      expect(await service.readFile(file)).toBe('{"a":1}')
    })
  })

  it('writeFileExclusive(target, data) creates once without overwriting the first data', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'runtime.lock')
      expect(await service.writeFileExclusive(file, 'first owner')).toBe(true)
      expect(await service.writeFileExclusive(file, 'second owner')).toBe(false)
      expect(await service.readFile(file)).toBe('first owner')
    })
  })

  it('writeFileExclusive(target, data) succeeds after the previous target is removed', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'runtime.lock')
      await service.writeFileExclusive(file, 'first owner')
      await service.remove(file)
      expect(await service.writeFileExclusive(file, 'next owner')).toBe(true)
      expect(await service.readFile(file)).toBe('next owner')
    })
  })

  it('mkdir creates nested directories recursively', async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, 'a', 'b', 'c')
      await service.mkdir(nested)
      expect(await service.exists(nested)).toBe(true)
    })
  })

  it('readDir reports files, directories and symlinks', async () => {
    await withTempDir(async (dir) => {
      await service.writeFile(path.join(dir, 'a.txt'), 'x')
      await service.mkdir(path.join(dir, 'sub'))
      const entries = await service.readDir(dir)
      expect(entries.some((e) => e.name === 'a.txt' && e.isFile)).toBe(true)
      expect(entries.some((e) => e.name === 'sub' && e.isDirectory)).toBe(true)
    })
  })

  it('copies a single file', async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, 'src.txt')
      const dest = path.join(dir, 'dest.txt')
      await service.writeFile(src, 'hello')
      await service.copy(src, dest)
      expect(await service.readFile(dest)).toBe('hello')
    })
  })

  it('copies a directory recursively', async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, 'skill')
      await service.mkdir(path.join(src, 'scripts'))
      await service.writeFile(path.join(src, 'SKILL.md'), '# s')
      await service.writeFile(path.join(src, 'scripts', 'run.js'), '// js')
      const dest = path.join(dir, 'copy')
      await service.copy(src, dest)
      expect(await service.readFile(path.join(dest, 'SKILL.md'))).toBe('# s')
      expect(await service.readFile(path.join(dest, 'scripts', 'run.js'))).toBe('// js')
    })
  })

  it('moves files between locations', async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, 'a.txt')
      const dest = path.join(dir, 'b.txt')
      await service.writeFile(src, 'data')
      await service.move(src, dest)
      expect(await service.exists(src)).toBe(false)
      expect(await service.readFile(dest)).toBe('data')
    })
  })

  it('removes files and directories', async () => {
    await withTempDir(async (dir) => {
      const sub = path.join(dir, 'sub')
      await service.mkdir(sub)
      await service.writeFile(path.join(sub, 'f.txt'), 'x')
      await service.remove(sub)
      expect(await service.exists(sub)).toBe(false)
    })
  })

  it('stat reports file type information', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 's.js')
      await service.writeFile(file, '// x')
      const stats = await service.stat(file)
      expect(stats.isFile()).toBe(true)
      expect(stats.isDirectory()).toBe(false)
    })
  })
})
