import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createWebServices } from './services.js'
import { createWebApp } from './app.js'

/**
 * GAP 1.2 — `GET /api/settings` / `PUT /api/settings` — validates the editable
 * subset of the Machine Config, deep-merges patches so untouched fields
 * survive, and persists the result to `~/.skillbox/config.json`.
 */
describe('GET /api/settings', () => {
  it('returns the empty config when no config file exists yet', async () => {
    await withApp(async (app) => {
      const response = await app.request('/api/settings')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { settings: unknown }
      expect(body.settings).toEqual({})
    })
  })

  it('returns the config that was persisted by a previous PUT', async () => {
    await withApp(async (app) => {
      await putSettings(app, { linkStrategy: 'copy' })
      const response = await app.request('/api/settings')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { settings: { linkStrategy: string } }
      expect(body.settings.linkStrategy).toBe('copy')
    })
  })
})

describe('PUT /api/settings', () => {
  it('merges only the touched fields and preserves untouched ones', async () => {
    await withApp(async (app, { configPath, home }) => {
      await writeFile(
        configPath,
        JSON.stringify({ repository: '/c/repo', linkStrategy: 'symlink', web: { open: false } }),
      )
      const response = await putSettings(app, { web: { port: 4321 } })
      expect(response.status).toBe(200)

      const body = (await response.json()) as {
        settings: { repository: string; linkStrategy: string; web: { port: number; open: boolean } }
      }
      expect(body.settings).toEqual({
        repository: '/c/repo',
        linkStrategy: 'symlink',
        web: { port: 4321, open: false },
      })

      const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      expect(persisted.repository).toBe('/c/repo')

      await rm(home, { recursive: true, force: true })
    })
  })

  it('writes agent path overrides and clears them with an empty path', async () => {
    await withApp(async (app, { configPath, home }) => {
      await putSettings(app, {
        agents: { claude: { path: '/mnt/claude', executable: 'claude' } },
      })
      await putSettings(app, { agents: { claude: { path: '' } } })

      const body = (await (await app.request('/api/settings')).json()) as {
        settings: { agents?: Record<string, unknown> }
      }
      expect(body.settings.agents).toBeUndefined()
      const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      expect(persisted.agents).toBeUndefined()

      await rm(home, { recursive: true, force: true })
    })
  })

  it('replaces a prior executable-only override when a path is set', async () => {
    await withApp(async (app, { configPath, home }) => {
      await writeFile(configPath, JSON.stringify({ agents: { codex: { executable: '/x/cx' } } }))
      const response = await putSettings(app, { agents: { codex: { path: '/y/cx' } } })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        settings: { agents: { codex: { path: string; executable?: string } } }
      }
      expect(body.settings.agents?.codex).toEqual({ path: '/y/cx' })

      await rm(home, { recursive: true, force: true })
    })
  })

  it('rejects an unknown link strategy with an INVALID_REQUEST envelope', async () => {
    await withApp(async (app) => {
      const response = await putSettings(app, { linkStrategy: 'hardlink' })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('rejects a missing "settings" body with an INVALID_REQUEST envelope', async () => {
    await withApp(async (app) => {
      const response = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ web: { port: 1 } }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('rejects an out-of-range web port with an INVALID_REQUEST envelope', async () => {
    await withApp(async (app) => {
      const response = await putSettings(app, { web: { port: 70000 } })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('rejects a malformed agent override with an INVALID_REQUEST envelope', async () => {
    await withApp(async (app) => {
      const response = await putSettings(app, { agents: { claude: { executable: '/x' } } })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })
})

interface Paths {
  configPath: string
  home: string
}

async function withApp(run: (app: Hono, paths: Paths) => Promise<void>): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-api-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'skillbox-web-api-home-'))
  try {
    const services = createWebServices({ repositoryRoot: repository, homeRoot: home })
    const app = createWebApp({ services })
    await run(app, { configPath: join(home, 'config.json'), home })
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

function putSettings(app: Hono, settings: Record<string, unknown>): ReturnType<Hono['request']> {
  return app.request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
}
