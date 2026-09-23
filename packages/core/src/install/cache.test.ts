import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { withTempDir } from '../fs/test-utils.js'
import { REGISTRY_SOURCE_TYPES, type NormalizedSource } from '../registry/types.js'
import {
  CACHE_INTEGRITY_MARKER,
  ManagedCache,
  cacheSourceKey,
  canonicalSourceString,
  clearCache,
  describeSource,
  sourceIdentityFields,
} from './cache.js'

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

const GIT_URL = 'https://git.example.com/org/repo.git'

interface SourceTextCase {
  readonly label: string
  readonly source: NormalizedSource
  /** Spelling used in transaction errors and CLI status lines. */
  readonly display: string
}

/**
 * Every `NormalizedSource` variant, with each optional field set and unset.
 *
 * `display` is the human spelling (`skills.sh/<package>@<path>#<version>`
 * grammar); the cache key is a separate, structural form — see the identity
 * tests below, which is the point: a message may abbreviate, a key may not.
 */
const SOURCE_TEXT_CASES: readonly SourceTextCase[] = [
  {
    label: 'github bare',
    source: { type: 'github', repo: 'acme/skillz' },
    display: 'github:acme/skillz',
  },
  {
    label: 'github path',
    source: { type: 'github', repo: 'acme/skillz', path: 'skills/hello' },
    display: 'github:acme/skillz@skills/hello',
  },
  {
    label: 'github path + tag ref',
    source: { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'v1.0.0' },
    display: 'github:acme/skillz@skills/hello#v1.0.0',
  },
  {
    label: 'github path + branch-shaped ref',
    source: { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
    display: 'github:acme/skillz@skills/hello#main',
  },
  {
    label: 'github branch only',
    source: { type: 'github', repo: 'acme/skillz', branch: 'main' },
    display: 'github:acme/skillz#main',
  },
  {
    label: 'skills-sh package',
    source: { type: 'skills-sh', package: 'acme/skillz' },
    display: 'skills-sh:acme/skillz',
  },
  {
    label: 'skills-sh package + version',
    source: { type: 'skills-sh', package: 'acme/skillz', version: '1.2.0' },
    display: 'skills-sh:acme/skillz#1.2.0',
  },
  {
    label: 'skills-sh package + path',
    source: { type: 'skills-sh', package: 'acme/skillz', path: 'skills/foo' },
    display: 'skills-sh:acme/skillz@skills/foo',
  },
  {
    label: 'skills-sh package + path + version',
    source: {
      type: 'skills-sh',
      package: 'acme/skillz',
      path: 'skills/foo',
      version: '1.2.0',
    },
    display: 'skills-sh:acme/skillz@skills/foo#1.2.0',
  },
  {
    label: 'git url',
    source: { type: 'git', url: GIT_URL },
    display: `git:${GIT_URL}`,
  },
  {
    label: 'git url + path + ref',
    source: { type: 'git', url: GIT_URL, path: 'skills/demo', ref: 'main' },
    display: `git:${GIT_URL}@skills/demo#main`,
  },
  {
    label: 'local',
    source: { type: 'local', path: '/abs/skills/foo' },
    display: 'local:/abs/skills/foo',
  },
]

describe('source text (display)', () => {
  it('covers every normalized source variant', () => {
    const covered = new Set(SOURCE_TEXT_CASES.map((testCase) => testCase.source.type))
    expect([...covered].sort()).toEqual([...REGISTRY_SOURCE_TYPES].sort())
  })

  it('pins the display spelling byte-for-byte', () => {
    for (const testCase of SOURCE_TEXT_CASES) {
      expect(describeSource(testCase.source), testCase.label).toBe(testCase.display)
    }
  })

  it('never renders two of the pinned sources as the same message', () => {
    const seen = new Map<string, string>()
    for (const testCase of SOURCE_TEXT_CASES) {
      const previous = seen.get(testCase.display)
      expect(previous, `${testCase.label} reuses ${previous}'s display string`).toBeUndefined()
      seen.set(testCase.display, testCase.label)
    }
  })
})

describe('source identity (the cache key)', () => {
  /** Sources that differ only in the field named by `difference`. */
  const MUST_DIFFER: readonly [NormalizedSource, NormalizedSource, string][] = [
    [
      { type: 'skills-sh', package: 'acme/skillz', path: 'skills/a' },
      { type: 'skills-sh', package: 'acme/skillz', path: 'skills/b' },
      'skills.sh path: two skills of one package',
    ],
    [
      { type: 'skills-sh', package: 'acme/skillz', path: 'skills/a' },
      { type: 'skills-sh', package: 'acme/skillz' },
      'skills.sh path presence',
    ],
    [
      { type: 'github', repo: 'acme/skillz', path: 'skills/a' },
      { type: 'github', repo: 'acme/skillz', path: 'skills/b' },
      'github path',
    ],
    [
      { type: 'git', url: GIT_URL, ref: 'main' },
      { type: 'git', url: GIT_URL, ref: 'dev' },
      'git ref',
    ],
    [
      // The class a `@`/`#`-joined spelling cannot express: a `package` holding
      // an `@` must not read as the same source as one with a `path`.
      { type: 'skills-sh', package: 'acme/skillz@skills/a' },
      { type: 'skills-sh', package: 'acme/skillz', path: 'skills/a' },
      'separator inside a field value',
    ],
  ]

  for (const [left, right, difference] of MUST_DIFFER) {
    it(`keys sources that differ by ${difference} apart`, () => {
      expect(cacheSourceKey(left)).not.toBe(cacheSourceKey(right))
    })
  }

  it('folds a `branch` pin into `ref`, which selects the same content', () => {
    const pinned: NormalizedSource = { type: 'github', repo: 'acme/skillz', ref: 'main' }
    const branched: NormalizedSource = { type: 'github', repo: 'acme/skillz', branch: 'main' }
    expect(cacheSourceKey(branched)).toBe(cacheSourceKey(pinned))
  })

  it('keys the same source identically whatever order its fields were built in', () => {
    const written: NormalizedSource = { type: 'git', url: GIT_URL, path: 'skills/demo' }
    const reordered = { url: GIT_URL, path: 'skills/demo', type: 'git' } as NormalizedSource
    expect(cacheSourceKey(reordered)).toBe(cacheSourceKey(written))
  })

  it('keeps every field the source carries', () => {
    expect(sourceIdentityFields({ type: 'local', path: '/abs/skills/foo' })).toEqual([
      ['path', '/abs/skills/foo'],
      ['type', 'local'],
    ])
  })

  it('treats a present-but-undefined field as absent', () => {
    // A zod-parsed lockfile source can carry `path: undefined` as a real key; it
    // must not hash apart from the same source without the key.
    const parsed: unknown = { type: 'github', repo: 'acme/skillz', path: undefined }
    expect(cacheSourceKey(parsed as NormalizedSource)).toBe(
      cacheSourceKey({ type: 'github', repo: 'acme/skillz' }),
    )
  })

  /** Byte-pin of the string whose digest names `cache/<source-key>/`. */
  it('serializes identity as sorted field pairs', () => {
    expect(canonicalSourceString({ type: 'local', path: '/abs/skills/foo' })).toBe(
      '[["path","/abs/skills/foo"],["type","local"]]',
    )
  })

  /**
   * The regression this whole shape exists for: the skills.sh `path` was left out
   * of the key while it was shown in messages, so `@skills/b` hit `@skills/a`'s
   * cache entry — and `transaction.ts` then adopted that entry's integrity as the
   * expectation for the new skill, which installed A's content under B's name.
   */
  it("does not serve one skill of a package from another skill's cache entry", async () => {
    await withTempDir(async (dir) => {
      const cacheRoot = path.join(dir, 'cache')
      const cache = new ManagedCache(cacheRoot)
      const first: NormalizedSource = {
        type: 'skills-sh',
        package: 'acme/skillz',
        path: 'skills/a',
      }
      const second: NormalizedSource = {
        type: 'skills-sh',
        package: 'acme/skillz',
        path: 'skills/b',
      }
      const seed = path.join(dir, 'seed')
      await fs.mkdir(seed, { recursive: true })
      await seedSkill(seed)
      const entry = await cache.put(first, 'head-rev', 'sha256:aa', seed)

      expect(await cache.get(second, 'head-rev')).toBeNull()
      expect(await cache.get(second, 'head-rev', 'sha256:aa')).toBeNull()
      expect((await cache.get(first, 'head-rev'))?.path).toBe(entry.path)
    })
  })
})
