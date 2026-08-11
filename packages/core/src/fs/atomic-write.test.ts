import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteFile, type AtomicWriteFs } from './atomic-write.js'
import { withTempDir } from './test-utils.js'

function listFiles(dir: string): Promise<string[]> {
  return fs.readdir(dir)
}

describe('atomicWriteFile', () => {
  it('creates a new file with parent directories', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'state', 'runtime.json')
      await atomicWriteFile(target, '{"pid":1}')
      expect(await fs.readFile(target, 'utf8')).toBe('{"pid":1}')
    })
  })

  it('replaces existing content atomically', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'skillbox.yaml')
      await fs.writeFile(target, 'version: 0')
      await atomicWriteFile(target, 'version: 1')
      expect(await fs.readFile(target, 'utf8')).toBe('version: 1')
      expect(await listFiles(dir)).toEqual([path.basename(target)])
    })
  })

  it('does not corrupt the previous file when the temp write fails', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'config.json')
      await fs.writeFile(target, 'OLD')
      const failingFs: Partial<AtomicWriteFs> = {
        writeFile: async () => {
          throw new Error('disk full')
        },
      }
      await expect(atomicWriteFile(target, 'NEW', { fs: failingFs })).rejects.toMatchObject({
        code: 'IO_ERROR',
      })
      expect(await fs.readFile(target, 'utf8')).toBe('OLD')
      expect(await listFiles(dir)).toEqual([path.basename(target)])
    })
  })

  it('keeps the previous file when the rename fails mid-way', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'lock.json')
      await fs.writeFile(target, 'OLD')
      const failingFs: Partial<AtomicWriteFs> = {
        rename: async () => {
          throw new Error('rename denied')
        },
      }
      await expect(atomicWriteFile(target, 'NEW', { fs: failingFs })).rejects.toMatchObject({
        code: 'IO_ERROR',
      })
      expect(await fs.readFile(target, 'utf8')).toBe('OLD')
      expect(await listFiles(dir)).toEqual([path.basename(target)])
    })
  })

  it('removes the stray temp file after a failed write', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'stray.txt')
      const failingFs: Partial<AtomicWriteFs> = {
        writeFile: async () => {
          throw new Error('boom')
        },
      }
      await expect(atomicWriteFile(target, 'x', { fs: failingFs })).rejects.toMatchObject({
        code: 'IO_ERROR',
      })
      expect(await listFiles(dir)).toEqual([])
    })
  })
})
