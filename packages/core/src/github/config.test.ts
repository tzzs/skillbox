import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { RuntimeConfigService } from '../runtime/config.js'
import { GitHubConfigStore } from './config.js'
import { withTempDir } from '../fs/test-utils.js'

function makeStore(dir: string) {
  const config = new RuntimeConfigService({ configFilePath: path.join(dir, 'config.json') })
  return { config, store: new GitHubConfigStore(config) }
}

describe('GitHubConfigStore', () => {
  it('defaults to not-connected when config.json is absent', async () => {
    await withTempDir(async (dir) => {
      const { store } = makeStore(dir)
      expect(await store.read()).toEqual({ connected: false })
    })
  })

  it('persists the connected account metadata without any token fields', async () => {
    await withTempDir(async (dir) => {
      const { store } = makeStore(dir)
      await store.writeConnected({
        login: 'octocat',
        provider: 'github-app',
        repository: 'octocat/skillbox-skills',
      })
      expect(await store.read()).toEqual({
        connected: true,
        login: 'octocat',
        provider: 'github-app',
        repository: 'octocat/skillbox-skills',
      })
      const raw = await fs.readFile(path.join(dir, 'config.json'), 'utf8')
      expect(raw).not.toContain('accessToken')
      expect(raw).not.toContain('refreshToken')
      expect(raw).not.toContain('ghu_')
    })
  })

  it('keeps repository bookkeeping when writing a connected account', async () => {
    await withTempDir(async (dir) => {
      const { config, store } = makeStore(dir)
      await config.save({
        repository: 'C:/repo',
        github: { connected: true, login: 'old', provider: 'github-app' },
      })
      await store.writeConnected({ login: 'new', provider: 'github-app' })
      const runtime = await config.load()
      expect(runtime.repository).toBe('C:/repo')
      expect(runtime.github).toMatchObject({ connected: true, login: 'new' })
    })
  })

  it('clearRepository drops only the repository binding', async () => {
    await withTempDir(async (dir) => {
      const { store } = makeStore(dir)
      await store.writeConnected({
        login: 'octocat',
        provider: 'github-app',
        repository: 'octocat/skillbox-skills',
      })
      await store.clearRepository()
      expect(await store.read()).toEqual({
        connected: true,
        login: 'octocat',
        provider: 'github-app',
      })
    })
  })

  it('clearRepository is a no-op when no github block exists', async () => {
    await withTempDir(async (dir) => {
      const { config, store } = makeStore(dir)
      await config.save({ repository: 'C:/repo' })
      await store.clearRepository()
      expect((await config.load()).github).toBeUndefined()
    })
  })

  it('clear removes the whole github block for disconnect', async () => {
    await withTempDir(async (dir) => {
      const { config, store } = makeStore(dir)
      await store.writeConnected({
        login: 'octocat',
        provider: 'github-app',
        repository: 'octocat/skillbox-skills',
      })
      await store.clear()
      expect(await store.read()).toEqual({ connected: false })
      expect((await config.load()).github).toBeUndefined()
      expect((await config.load()).repository).toBeUndefined()
    })
  })
})
