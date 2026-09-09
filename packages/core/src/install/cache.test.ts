import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { withTempDir } from '../fs/test-utils.js'
import type { NormalizedSource } from '../registry/types.js'
import { CACHE_INTEGRITY_MARKER, ManagedCache, cacheSourceKey, clearCache } from './cache.js'

const GITHUB_SOURCE: NormalizedSource = {
  type: 'github',
  repo: 'acme/skillz',
  path: 'skills/hello',
  ref: 'main',
}

const OTHER_SOURCE: NormalizedSource = {
  type: 'github',
  repo: 'acme/skillz',
  path: 'skills/other',
  ref: 'main',
}

async function seedSkill(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), '# hello\n', 'utf8')
  await fs.writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n', 'utf8')
}

describe('ManagedCache', () => {
  it('stores entries under cache/<source-key>/<revision> with an integrity marker', async () => {
    await withTempDir(async (dir) => {
      const cacheRoot = path.join(dir, 'cache')
      const seed = path.join(dir, 'seed')
      await seedSkill(seed)
      const cache = new ManagedCache(cacheRoot)

      const entry = await cache.put(GITHUB_SOURCE, 'abc123', 'sha256:aa', seed)
      expect(entry.path).toBe(path.join(cacheRoot, cacheSourceKey(GITHUB_SOURCE), 'abc123'))
      expect(await fs.stat(path.join(entry.path, 'SKILL.md'))).toBeDefined()
      const marker = await fs.readFile(`${entry.path}${CACHE_INTEGRITY_MARKER}`, 'utf8')
      expect(marker.trim()).toBe('sha256:aa')
    })
  })

  it('returns a verified entry on a hit', async () => {
    await withTempDir(async (dir) => {
      const cache = new ManagedCache(path.join(dir, 'cache'))
      const seed = path.join(dir, 'seed')
      await seedSkill(seed)
      await cache.put(GITHUB_SOURCE, 'abc123', 'sha256:aa', seed)

      const entry = await cache.get(GITHUB_SOURCE, 'abc123', 'sha256:aa')
      expect(entry).not.toBeNull()
      expect(entry?.integrity).toBe('sha256:aa')
      expect(await fs.stat(path.join(entry!.path, 'SKILL.md'))).toBeDefined()
    })
  })

  it('returns null on a miss (download is the normal path)', async () => {
    await withTempDir(async (dir) => {
      const cache = new ManagedCache(path.join(dir, 'cache'))
      expect(await cache.get(GITHUB_SOURCE, 'nope')).toBeNull()
      await expect(cache.requireEntry(GITHUB_SOURCE, 'nope')).rejects.toMatchObject({
        code: 'CACHE_MISS',
      })
    })
  })

  it('throws CACHE_INVALID when the marker does not match the expected integrity', async () => {
    await withTempDir(async (dir) => {
      const cache = new ManagedCache(path.join(dir, 'cache'))
      const seed = path.join(dir, 'seed')
      await seedSkill(seed)
      await cache.put(GITHUB_SOURCE, 'abc123', 'sha256:aa', seed)

      await expect(cache.get(GITHUB_SOURCE, 'abc123', 'sha256:bb')).rejects.toMatchObject({
        code: 'CACHE_INVALID',
      })
    })
  })

  it('throws CACHE_INVALID for an entry with a missing or empty marker', async () => {
    await withTempDir(async (dir) => {
      const cache = new ManagedCache(path.join(dir, 'cache'))
      const entryDir = cache.entryDir(GITHUB_SOURCE, 'abc123')
      await fs.mkdir(entryDir, { recursive: true })
      await fs.writeFile(path.join(entryDir, 'SKILL.md'), '# x\n', 'utf8')

      await expect(cache.get(GITHUB_SOURCE, 'abc123')).rejects.toMatchObject({
        code: 'CACHE_INVALID',
      })

      await fs.writeFile(`${entryDir}${CACHE_INTEGRITY_MARKER}`, '   \n', 'utf8')
      await expect(cache.get(GITHUB_SOURCE, 'abc123')).rejects.toMatchObject({
        code: 'CACHE_INVALID',
      })
    })
  })

  it('rejects unsafe revisions in the cache layout', async () => {
    await withTempDir(async (dir) => {
      const cache = new ManagedCache(path.join(dir, 'cache'))
      await expect(cache.get(GITHUB_SOURCE, '../../escape')).rejects.toMatchObject({
        code: 'CACHE_INVALID',
      })
    })
  })

  it('invalidate purges one entry; clear removes the whole cache', async () => {
    await withTempDir(async (dir) => {
      const filesystem = new FilesystemService()
      const cache = new ManagedCache(path.join(dir, 'cache'), filesystem)
      const seed = path.join(dir, 'seed')
      await seedSkill(seed)
      await cache.put(GITHUB_SOURCE, 'abc123', 'sha256:aa', seed)
      await cache.put(OTHER_SOURCE, 'abc123', 'sha256:bb', seed)

      await cache.invalidate(GITHUB_SOURCE, 'abc123')
      expect(await cache.get(GITHUB_SOURCE, 'abc123')).toBeNull()
      expect(await cache.get(OTHER_SOURCE, 'abc123')).not.toBeNull()

      await cache.clear()
      expect(await filesystem.exists(path.join(dir, 'cache'))).toBe(false)
    })
  })

  it('source keys differ when the source differs but stay stable for the same source', () => {
    expect(cacheSourceKey(GITHUB_SOURCE)).toBe(cacheSourceKey(GITHUB_SOURCE))
    expect(cacheSourceKey(GITHUB_SOURCE)).not.toBe(cacheSourceKey(OTHER_SOURCE))
  })

  it('clearCache() clears the default home cache', async () => {
    await withTempDir(async (dir) => {
      const cache = new ManagedCache(path.join(dir, 'cache'))
      const seed = path.join(dir, 'seed')
      await seedSkill(seed)
      await cache.put(GITHUB_SOURCE, 'abc123', 'sha256:aa', seed)
      await clearCache(dir)
      expect(await cache.get(GITHUB_SOURCE, 'abc123')).toBeNull()
    })
  })
})
