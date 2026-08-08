import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { resolveLinkStrategy, createLink } from './links.js'
import { linksSupported, tempDir, cleanup } from './test-utils.js'

describe('resolveLinkStrategy', () => {
  it('maps auto to the platform default', () => {
    expect(resolveLinkStrategy('auto', 'win32')).toBe('junction')
    expect(resolveLinkStrategy('auto', 'darwin')).toBe('symlink')
    expect(resolveLinkStrategy('auto', 'linux')).toBe('symlink')
  })

  it('passes through explicit strategies', () => {
    expect(resolveLinkStrategy('symlink', 'win32')).toBe('symlink')
    expect(resolveLinkStrategy('junction', 'darwin')).toBe('junction')
    expect(resolveLinkStrategy('copy', 'linux')).toBe('copy')
  })
})

describe('createLink', () => {
  it('copies a directory tree with the copy strategy', async () => {
    const root = await tempDir()
    try {
      const source = path.join(root, 'src')
      await fs.mkdir(source, { recursive: true })
      await fs.writeFile(path.join(source, 'a.txt'), 'hello')

      const destination = path.join(root, 'dest')
      const result = await createLink(source, destination, { strategy: 'copy' })
      expect(result.strategy).toBe('copy')
      expect(result.usedFallback).toBe(false)
      expect(await fs.readFile(path.join(destination, 'a.txt'), 'utf8')).toBe('hello')
    } finally {
      await cleanup(root)
    }
  })

  it('falls back to copy when synmylink creation fails', async () => {
    const root = await tempDir()
    try {
      const source = path.join(root, 'src')
      await fs.mkdir(source, { recursive: true })
      await fs.writeFile(path.join(source, 'a.txt'), 'data')

      const destination = path.join(root, 'dest')
      const result = await createLink(source, destination, {
        strategy: 'symlink',
        platform: 'darwin',
        deps: {
          symlink: async () => {
            throw new Error('EPERM: symlink not permitted')
          },
        },
      })
      expect(result.strategy).toBe('symlink')
      expect(result.usedFallback).toBe(true)
      expect(await fs.readFile(path.join(destination, 'a.txt'), 'utf8')).toBe('data')
    } finally {
      await cleanup(root)
    }
  })

  it.skipIf(!linksSupported)('auto creates a real link on this platform', async () => {
    const root = await tempDir()
    try {
      const source = path.join(root, 'src')
      await fs.mkdir(source, { recursive: true })
      await fs.writeFile(path.join(source, 'a.txt'), 'v')

      const destination = path.join(root, 'dest')
      const result = await createLink(source, destination, { strategy: 'auto' })
      expect(result.usedFallback).toBe(false)
      expect(await fs.readFile(path.join(destination, 'a.txt'), 'utf8')).toBe('v')
    } finally {
      await cleanup(root)
    }
  })

  it.skipIf(!linksSupported)('junction links on Windows resolve to the source', async () => {
    const root = await tempDir()
    try {
      const source = path.join(root, 'src')
      await fs.mkdir(source, { recursive: true })
      await fs.writeFile(path.join(source, 'x.txt'), 'ok')
      const destination = path.join(root, 'junction-dest')
      const result = await createLink(source, destination, { strategy: 'junction' })
      expect(result.strategy).toBe('junction')
      expect(result.usedFallback).toBe(false)
      try {
        expect(await fs.readFile(path.join(destination, 'x.txt'), 'utf8')).toBe('ok')
      } finally {
        await fs.rm(destination, { recursive: false, force: true }).catch(() => {})
      }
    } finally {
      await cleanup(root)
    }
  })
})
