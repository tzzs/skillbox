import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FilesystemMigrationStore } from './filesystem-store.js'

describe('FilesystemMigrationStore', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('durably checkpoints a migration once per resolved repository', async () => {
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-migrations-'))
    roots.push(homeRoot)
    const repositoryRoot = path.join(homeRoot, 'repo')
    const store = new FilesystemMigrationStore({ homeRoot })

    await store.markCompleted('manifest-v1', repositoryRoot)
    await store.markCompleted('manifest-v1', repositoryRoot)

    await expect(store.listCompleted(repositoryRoot)).resolves.toEqual(['manifest-v1'])
    const reloaded = new FilesystemMigrationStore({ homeRoot })
    await expect(reloaded.listCompleted(repositoryRoot)).resolves.toEqual(['manifest-v1'])
  })

  it('keeps checkpoints isolated between repositories', async () => {
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-migrations-'))
    roots.push(homeRoot)
    const store = new FilesystemMigrationStore({ homeRoot })

    await store.markCompleted('lock-v2', path.join(homeRoot, 'one'))

    await expect(store.listCompleted(path.join(homeRoot, 'two'))).resolves.toEqual([])
  })
})
