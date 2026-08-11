import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { ErrorCode } from '../errors.js'
import { readManifest } from '../manifest/index.js'
import { detectManagedModifications, ensureForkBeforeEdit } from './modification.js'
import { forkSkill } from './fork.js'
import { modifyManagedCopy, seedManagedSkill } from './test-utils.js'

describe('detectManagedModifications', () => {
  it('returns true when the managed runtime copy diverged from the lockfile', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed)
      await expect(
        detectManagedModifications(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).resolves.toBe(true)
    })
  })

  it('returns false when the runtime copy matches the lockfile', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await expect(
        detectManagedModifications(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).resolves.toBe(false)
    })
  })

  it('returns false for non-managed skills (forked after conversion)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await forkSkill(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
      })
      await modifyManagedCopy(seed) // even a modified managed copy is irrelevant
      await expect(
        detectManagedModifications(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).resolves.toBe(false)
    })
  })

  it('returns false when the runtime copy is missing', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir, { withManagedCopy: false })
      await expect(
        detectManagedModifications(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).resolves.toBe(false)
    })
  })

  it('returns false when the lockfile is missing entirely', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir, { noLockEntry: true })
      await fs.rm(path.join(seed.repositoryRoot, 'skillbox.lock'), { force: true })
      await expect(
        detectManagedModifications(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).resolves.toBe(false)
    })
  })

  it('throws SKILL_NOT_FOUND for unknown skills', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await expect(
        detectManagedModifications('ghost', {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SKILL_NOT_FOUND })
    })
  })
})

describe('ensureForkBeforeEdit', () => {
  it('returns null when the managed copy is pristine', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await expect(
        ensureForkBeforeEdit(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).resolves.toBeNull()
    })
  })

  it('returns null when the skill is already forked', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await forkSkill(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
      })
      await expect(
        ensureForkBeforeEdit(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).resolves.toBeNull()
    })
  })

  it('throws a recoverable LIFECYCLE_MANAGED_MODIFIED when modified', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed)

      let caught: unknown
      try {
        await ensureForkBeforeEdit(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        })
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({
        code: ErrorCode.LIFECYCLE_MANAGED_MODIFIED,
        recoverable: true,
      })
    })
  })

  it('auto-converts to a fork when autoConvert is set', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await modifyManagedCopy(seed)

      const result = await ensureForkBeforeEdit(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
        autoConvert: true,
      })

      expect(result).not.toBeNull()
      expect(result?.mode).toBe('forked')
      const manifest = await readManifest(seed.repositoryRoot)
      expect(manifest.skills.hello).toMatchObject({ mode: 'forked' })
      expect(
        await detectManagedModifications(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).toBe(false)
    })
  })

  it('throws SKILL_NOT_FOUND for unknown skills', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await expect(
        ensureForkBeforeEdit('ghost', {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SKILL_NOT_FOUND })
    })
  })
})
