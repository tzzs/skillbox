import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { ErrorCode } from '../errors.js'
import { readLockfile } from '../lockfile/index.js'
import { addSkill, emptyManifest, readManifest, writeManifest } from '../manifest/index.js'
import { createOperationRuntime } from '../operations/index.js'
import { forkSkill } from './fork.js'
import { FailingFilesystem, matches, seedManagedSkill } from './test-utils.js'
import { vendorSkill } from './vendor.js'

describe('vendorSkill', () => {
  it('vendors a managed skill (M18.1: copy, localize, drop upstream)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const { repositoryRoot: repo, homeRoot: home } = seed

      const result = await vendorSkill(seed.alias, { repositoryRoot: repo, homeRoot: home })

      expect(result.mode).toBe('vendored')
      expect(result.fromFork).toBe(false)
      expect(result.repositoryPath).toBe('skills/hello')
      expect(result.integrity).toBe(seed.lockedIntegrity)
      expect(result.removedBaseSnapshot).toBeUndefined()

      // Content copied into the repository.
      expect(await fs.readFile(path.join(repo, 'skills', 'hello', 'SKILL.md'), 'utf8')).toBe(
        '# hello\n',
      )

      const manifest = await readManifest(repo)
      expect(manifest.skills.hello).toMatchObject({
        mode: 'vendored',
        source: { type: 'local', path: 'skills/hello' },
      })
      expect(manifest.skills.hello?.upstream).toBeUndefined()

      const locked = (await readLockfile(repo)).skills.hello
      expect(locked).toMatchObject({
        mode: 'vendored',
        source: { type: 'local', path: 'skills/hello' },
        integrity: seed.lockedIntegrity,
      })
      expect(locked?.upstream).toBeUndefined()
      expect(locked?.revision).toBeUndefined()
    })
  })

  it('records provenance when keepProvenance is set (M18.3)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const { repositoryRoot: repo, homeRoot: home } = seed

      await vendorSkill(seed.alias, {
        repositoryRoot: repo,
        homeRoot: home,
        keepProvenance: true,
      })

      const locked = (await readLockfile(repo)).skills.hello
      expect(locked?.metadata).toEqual({ originalSource: seed.upstream })
    })
  })

  it('vendors a forked skill (M18.2: stop upstream tracking, keep content)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const { repositoryRoot: repo, homeRoot: home } = seed
      const forked = await forkSkill(seed.alias, { repositoryRoot: repo, homeRoot: home })
      const baseDir = forked.baseSnapshotPath

      const result = await vendorSkill(seed.alias, {
        repositoryRoot: repo,
        homeRoot: home,
        removeBaseSnapshot: true,
      })

      expect(result.fromFork).toBe(true)
      expect(result.integrity).toBe(seed.lockedIntegrity)
      // The whole `.skillbox/bases/<alias>` tree is removed (M18.2).
      expect(result.removedBaseSnapshot).toBe(path.join(repo, '.skillbox', 'bases', 'hello'))

      // Content stays in the repository, base snapshot deleted.
      expect(await fs.readFile(path.join(repo, 'skills', 'hello', 'SKILL.md'), 'utf8')).toBe(
        '# hello\n',
      )
      await expect(fs.stat(baseDir)).rejects.toThrow()
      await expect(fs.stat(path.join(repo, '.skillbox', 'bases', 'hello'))).rejects.toThrow()

      const manifest = await readManifest(repo)
      expect(manifest.skills.hello).toMatchObject({ mode: 'vendored' })
      expect(manifest.skills.hello?.upstream).toBeUndefined()

      const locked = (await readLockfile(repo)).skills.hello
      expect(locked).toMatchObject({ mode: 'vendored' })
      expect(locked?.upstream).toBeUndefined()
    })
  }, 15_000)

  it('keeps the base snapshot when removeBaseSnapshot is not set', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const { repositoryRoot: repo, homeRoot: home } = seed
      const forked = await forkSkill(seed.alias, { repositoryRoot: repo, homeRoot: home })

      const result = await vendorSkill(seed.alias, { repositoryRoot: repo, homeRoot: home })

      expect(result.removedBaseSnapshot).toBeUndefined()
      expect(await fs.stat(forked.baseSnapshotPath)).toBeDefined()
    })
  })

  it('rejects vendored as a terminal state (vendored → forked)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const { repositoryRoot: repo, homeRoot: home } = seed
      await vendorSkill(seed.alias, { repositoryRoot: repo, homeRoot: home })

      await expect(
        forkSkill(seed.alias, { repositoryRoot: repo, homeRoot: home }),
      ).rejects.toMatchObject({
        code: ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
        context: { from: 'vendored', to: 'forked' },
      })
      await expect(
        vendorSkill(seed.alias, { repositoryRoot: repo, homeRoot: home }),
      ).rejects.toMatchObject({
        code: ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
        context: { from: 'vendored', to: 'vendored' },
      })
    })
  })

  it('rejects local skills (LIFECYCLE_ILLEGAL_TRANSITION)', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo')
      await fs.mkdir(repo, { recursive: true })
      await writeManifest(
        repo,
        addSkill(emptyManifest(), 'hello', {
          source: { type: 'local', path: 'skills/hello' },
          mode: 'local',
        }),
      )
      await fs.mkdir(path.join(repo, 'skills', 'hello'), { recursive: true })
      await fs.writeFile(path.join(repo, 'skills', 'hello', 'SKILL.md'), '# hello\n', 'utf8')

      await expect(
        vendorSkill('hello', { repositoryRoot: repo, homeRoot: path.join(dir, 'home') }),
      ).rejects.toMatchObject({
        code: ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
        context: { from: 'local', to: 'vendored' },
      })
    })
  })

  it('rejects an unknown skill (SKILL_NOT_FOUND)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await expect(
        vendorSkill('ghost', { repositoryRoot: seed.repositoryRoot, homeRoot: seed.homeRoot }),
      ).rejects.toMatchObject({ code: ErrorCode.SKILL_NOT_FOUND })
    })
  })

  it('rejects when the target skills/<alias> already exists (VENDOR_TARGET_EXISTS)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await fs.mkdir(path.join(seed.repositoryRoot, 'skills', 'hello'), { recursive: true })
      await fs.writeFile(path.join(seed.repositoryRoot, 'skills', 'hello', 'SKILL.md'), 'x\n')

      await expect(
        vendorSkill(seed.alias, { repositoryRoot: seed.repositoryRoot, homeRoot: seed.homeRoot }),
      ).rejects.toMatchObject({ code: ErrorCode.VENDOR_TARGET_EXISTS })
    })
  })

  it('rejects when the managed runtime copy is missing (SKILL_MISSING)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir, { withManagedCopy: false })
      await expect(
        vendorSkill(seed.alias, { repositoryRoot: seed.repositoryRoot, homeRoot: seed.homeRoot }),
      ).rejects.toMatchObject({ code: ErrorCode.SKILL_MISSING })
    })
  })

  it('rolls back a failed copy (no manifest/lockfile changes, no leftovers)', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      const failing = new FailingFilesystem(matches('skills/hello'))

      await expect(
        vendorSkill(seed.alias, {
          repositoryRoot: seed.repositoryRoot,
          homeRoot: seed.homeRoot,
          filesystem: failing,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.LIFECYCLE_COPY_FAILED })

      await expect(fs.stat(path.join(seed.repositoryRoot, 'skills', 'hello'))).rejects.toThrow()
      const manifest = await readManifest(seed.repositoryRoot)
      expect(manifest.skills.hello).toMatchObject({ mode: 'managed' })
      const lockfile = await readLockfile(seed.repositoryRoot)
      expect(lockfile.skills.hello).toMatchObject({ mode: 'managed' })
    })
  })

  it('records a vendor snapshot that can be rolled back after success', async () => {
    await withTempDir(async (dir) => {
      const seed = await seedManagedSkill(dir)
      await vendorSkill(seed.alias, {
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
      })

      await createOperationRuntime({
        repositoryRoot: seed.repositoryRoot,
        homeRoot: seed.homeRoot,
      }).rollback()

      expect((await readManifest(seed.repositoryRoot)).skills.hello).toMatchObject({
        mode: 'managed',
      })
      await expect(fs.stat(path.join(seed.repositoryRoot, 'skills', 'hello'))).rejects.toThrow()
    })
  }, 30_000)
})
