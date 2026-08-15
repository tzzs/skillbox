import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { ErrorCode } from '../errors.js'
import { MigrationRegistry } from './registry.js'
import { migrateConfigDocument } from './config.js'
import { migrateManifestDocument } from './manifest.js'
import { migrateRepository } from './index.js'

describe('MigrationRegistry', () => {
  it('applies migrations in order to the target version', () => {
    const registry = new MigrationRegistry<Record<string, unknown>>([
      { from: 0, to: 1, label: 'a', migrate: (doc) => ({ ...doc, a: true }) },
      { from: 1, to: 2, label: 'b', migrate: (doc) => ({ ...doc, b: true }) },
    ])

    const outcome = registry.apply(0, 2, { seed: 1 })

    expect(outcome).toEqual({
      document: { seed: 1, a: true, b: true },
      applied: ['a', 'b'],
      changed: true,
    })
  })

  it('is a no-op for an up-to-date document', () => {
    const registry = new MigrationRegistry<Record<string, unknown>>([])
    const outcome = registry.apply(2, 2, { x: 1 })
    expect(outcome).toEqual({ document: { x: 1 }, applied: [], changed: false })
  })

  it('fails with MIGRATION_MISSING when no migration is registered', () => {
    const registry = new MigrationRegistry<Record<string, unknown>>([])
    expect(() => registry.apply(0, 2, {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.MIGRATION_MISSING }),
    )
  })

  it('rejects a migration that does not bump the version forward', () => {
    const registry = new MigrationRegistry<Record<string, unknown>>([
      { from: 0, to: 0, label: 'broken', migrate: (doc) => doc },
    ])
    expect(() => registry.apply(0, 1, {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.MIGRATION_FAILED }),
    )
  })
})

describe('config migration', () => {
  it('stamps an unversioned (legacy) config as v1', () => {
    const outcome = migrateConfigDocument({ repository: '/repo', linkStrategy: 'copy' })
    expect(outcome.changed).toBe(true)
    expect(outcome.applied).toEqual(['config v0 → v1 (add version field)'])
    expect(outcome.document).toEqual({
      version: 1,
      repository: '/repo',
      linkStrategy: 'copy',
    })
  })

  it('leaves a v1 config unchanged', () => {
    const outcome = migrateConfigDocument({ version: 1, linkStrategy: 'symlink' })
    expect(outcome.changed).toBe(false)
    expect(outcome.applied).toEqual([])
    expect(outcome.document).toEqual({ version: 1, linkStrategy: 'symlink' })
  })

  it('refuses a config newer than the supported version', () => {
    expect(() => migrateConfigDocument({ version: 2 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.MIGRATION_FAILED }),
    )
  })
})

describe('manifest migration', () => {
  it('leaves a v1 manifest unchanged', () => {
    const raw = { version: 1, skills: {} }
    const outcome = migrateManifestDocument(raw)
    expect(outcome.changed).toBe(false)
    expect(outcome.document).toEqual({ version: 1, skills: {} })
  })

  it('fails with MIGRATION_MISSING for an older version with no migration', () => {
    expect(() => migrateManifestDocument({ version: 0, skills: {} })).toThrowError(
      expect.objectContaining({ code: ErrorCode.MIGRATION_MISSING }),
    )
  })

  it('rejects a manifest newer than the supported version', () => {
    expect(() => migrateManifestDocument({ version: 9, skills: {} })).toThrowError(
      expect.objectContaining({ code: ErrorCode.MIGRATION_FAILED }),
    )
  })
})

describe('migrateRepository', () => {
  it('migrates a legacy config.json in place and reports up-to-date manifest/lockfile', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo')
      const home = path.join(dir, 'home')
      await fs.mkdir(repo, { recursive: true })
      await fs.mkdir(path.join(home, 'state'), { recursive: true })
      await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ linkStrategy: 'copy' }))
      await fs.writeFile(path.join(repo, 'skillbox.yaml'), 'version: 1\nskills: {}\n')
      await fs.writeFile(path.join(repo, 'skillbox.lock'), 'lockfileVersion: 1\nskills: {}\n')

      const report = await migrateRepository(repo, { homeRoot: home })

      expect(report.config).toMatchObject({ present: true, changed: true })
      expect(report.config.applied).toEqual(['config v0 → v1 (add version field)'])
      expect(report.manifest).toMatchObject({ present: true, changed: false })
      expect(report.lockfile).toMatchObject({ present: true, changed: false })

      // The config on disk now carries version 1.
      const persisted = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8')) as {
        version?: number
      }
      expect(persisted.version).toBe(1)
    })
  })

  it('reports missing files without touching anything', async () => {
    await withTempDir(async (dir) => {
      const report = await migrateRepository(path.join(dir, 'repo'), {
        homeRoot: path.join(dir, 'home'),
      })
      expect(report.config).toMatchObject({ present: false, changed: false })
      expect(report.manifest).toMatchObject({ present: false, changed: false })
      expect(report.lockfile).toMatchObject({ present: false, changed: false })
    })
  })
})
