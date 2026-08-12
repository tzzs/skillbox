import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withTempDir } from '../fs/test-utils.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { ManagedCache } from '../install/cache.js'
import { readLockfile } from '../lockfile/index.js'
import { readManifest } from '../manifest/index.js'
import { createSkillSourceResolver } from '../sources/index.js'
import { detectManagedModifications } from './modification.js'
import { modifyManagedCopy, seedManagedSkill } from './test-utils.js'
import { restoreManagedSkill } from './restore.js'

async function seedPinnedCache(seed: Awaited<ReturnType<typeof seedManagedSkill>>): Promise<void> {
  const pristine = path.join(path.dirname(seed.repositoryRoot), 'pristine')
  await fs.mkdir(pristine, { recursive: true })
  await fs.writeFile(path.join(pristine, 'SKILL.md'), '# hello\n', 'utf8')
  await fs.writeFile(path.join(pristine, 'notes.md'), 'original\n', 'utf8')
  await new ManagedCache(seed.layout.cache).put(
    { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
    seed.revision,
    await computeSkillIntegrity(pristine),
    pristine,
  )
}

describe('restoreManagedSkill', () => {
  it('restores modified managed content from the exact pinned cache entry without changing metadata', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await seedPinnedCache(seed)
      const manifestBefore = await fs.readFile(
        path.join(seed.repositoryRoot, 'skillbox.yaml'),
        'utf8',
      )
      const lockBefore = await fs.readFile(path.join(seed.repositoryRoot, 'skillbox.lock'), 'utf8')
      await modifyManagedCopy(seed)

      const result = await restoreManagedSkill(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
      })

      expect(result.alias).toBe(seed.alias)
      expect(result.filesRestored).toBe(2)
      expect(result.integrity).toBe(seed.lockedIntegrity)
      expect(await fs.readFile(path.join(seed.managedPath, 'SKILL.md'), 'utf8')).toBe('# hello\n')
      await expect(fs.stat(path.join(seed.managedPath, 'edited.md'))).rejects.toThrow()
      expect(await detectManagedModifications(seed.alias, seed)).toBe(false)
      expect(await fs.readFile(path.join(seed.repositoryRoot, 'skillbox.yaml'), 'utf8')).toBe(
        manifestBefore,
      )
      expect(await fs.readFile(path.join(seed.repositoryRoot, 'skillbox.lock'), 'utf8')).toBe(
        lockBefore,
      )
    })
  })

  it('is idempotent when the managed runtime already matches its lock pin', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await seedPinnedCache(seed)
      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).resolves.toMatchObject({ filesRestored: 0, integrity: seed.lockedIntegrity })
    })
  })

  it('re-materializes the locked revision and repopulates the cache when its disposable entry is missing', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await seedPinnedCache(seed)
      const cache = new ManagedCache(seed.layout.cache)
      await cache.invalidate(
        { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
        seed.revision,
      )
      await modifyManagedCopy(seed)

      const pristine = path.join(path.dirname(seed.repositoryRoot), 'pristine')
      const materialized: Array<{ revision: string; targetDir: string }> = []
      const resolver = createSkillSourceResolver({
        adapters: [
          {
            type: 'github',
            capabilities: { resolve: false, download: false, latest: false, materialize: true },
            async materialize(_source, revision, targetDir) {
              materialized.push({ revision, targetDir })
              await fs.cp(pristine, targetDir, { recursive: true })
            },
          },
        ],
      })

      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          sourceResolver: resolver,
        }),
      ).resolves.toMatchObject({ integrity: seed.lockedIntegrity, filesRestored: 2 })

      expect(materialized).toHaveLength(1)
      expect(materialized[0]?.revision).toBe(seed.revision)
      expect(await fs.readFile(path.join(seed.managedPath, 'SKILL.md'), 'utf8')).toBe('# hello\n')
      expect(
        await cache.get(
          { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
          seed.revision,
          seed.lockedIntegrity,
        ),
      ).not.toBeNull()
    })
  })

  it('rejects a cache-miss materialization that differs from the locked integrity without replacing the runtime', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const cache = new ManagedCache(seed.layout.cache)
      await modifyManagedCopy(seed)
      const resolver = createSkillSourceResolver({
        adapters: [
          {
            type: 'github',
            capabilities: { resolve: false, download: false, latest: false, materialize: true },
            async materialize(_source, _revision, targetDir) {
              await fs.mkdir(targetDir, { recursive: true })
              await fs.writeFile(path.join(targetDir, 'SKILL.md'), '# corrupt\n', 'utf8')
            },
          },
        ],
      })

      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          sourceResolver: resolver,
        }),
      ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
      expect(await fs.readFile(path.join(seed.managedPath, 'edited.md'), 'utf8')).toBe('changed\n')
      expect(
        await cache.get(
          { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
          seed.revision,
        ),
      ).toBeNull()
    })
  })

  it('rejects a cache payload whose content does not match the lock integrity without touching the runtime', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed)
      const cache = new ManagedCache(seed.layout.cache)
      const corrupt = path.join(dir, 'corrupt')
      await fs.mkdir(corrupt, { recursive: true })
      await fs.writeFile(path.join(corrupt, 'SKILL.md'), '# corrupt\n', 'utf8')
      await cache.put(
        { type: 'github', repo: 'acme/skillz', path: 'skills/hello', ref: 'main' },
        seed.revision,
        seed.lockedIntegrity,
        corrupt,
      )

      await expect(
        restoreManagedSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
      expect(await fs.readFile(path.join(seed.managedPath, 'edited.md'), 'utf8')).toBe('changed\n')
      expect((await readManifest(seed.repositoryRoot)).skills.hello?.mode).toBe('managed')
      expect((await readLockfile(seed.repositoryRoot)).skills.hello?.integrity).toBe(
        seed.lockedIntegrity,
      )
    })
  })
})
