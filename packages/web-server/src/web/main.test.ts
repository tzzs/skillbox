import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  startWebServer,
  type WebCommandFlags,
  webOptionsFromFlags,
} from './main.js'
import type { WebServerOptions } from './types.js'

describe('webOptionsFromFlags', () => {
  it('maps an empty flags object to an empty options object', () => {
    expect(webOptionsFromFlags({})).toEqual({})
  })

  it('converts --port, --host and --repository into server options', () => {
    const flags: WebCommandFlags = { port: '3000', host: '0.0.0.0', repository: '/tmp/repo' }
    expect(webOptionsFromFlags(flags)).toEqual({
      port: 3000,
      host: '0.0.0.0',
      repositoryRoot: '/tmp/repo',
    })
  })

  it('keeps optional flags out of the result when absent (exactOptionalPropertyTypes)', () => {
    const options = webOptionsFromFlags({}) as Record<string, unknown>
    expect('port' in options).toBe(false)
    expect('host' in options).toBe(false)
    expect('open' in options).toBe(false)
    expect('repositoryRoot' in options).toBe(false)
  })

  it('maps --no-open to open:false', () => {
    expect(webOptionsFromFlags({ open: false })).toEqual({ open: false })
  })

  it('treats an empty --port value as absent', () => {
    expect(webOptionsFromFlags({ port: '' })).toEqual({})
  })
})

describe('server defaults', () => {
  it('exposes the default port and host used when no flags are given', () => {
    expect(DEFAULT_PORT).toBeGreaterThan(0)
    expect(DEFAULT_HOST.length).toBeGreaterThan(0)
  })
})

describe('startWebServer', () => {
  it('serves GET /api/health with status ok on an ephemeral port', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-repo-'))
    const home = await mkdtemp(join(tmpdir(), 'skillbox-web-home-'))
    try {
      const options: WebServerOptions = {
        repositoryRoot: repository,
        homeRoot: home,
        port: 0,
        open: false,
        out: () => undefined,
        err: () => undefined,
      }
      const started = await startWebServer(options)
      try {
        const response = await fetch(`${started.url}/api/health`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status: string; repository: string; home: string }
        expect(body.status).toBe('ok')
        expect(body.repository).toBe(repository)
        expect(body.home).toBe(home)
      } finally {
        await started.close()
      }
    } finally {
      await rm(repository, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports a preview endpoint returning 503 when the static frontend is missing', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-repo-'))
    const home = await mkdtemp(join(tmpdir(), 'skillbox-web-home-'))
    try {
      const started = await startWebServer({
        repositoryRoot: repository,
        homeRoot: home,
        port: 0,
        open: false,
        out: () => undefined,
        err: () => undefined,
      })
      try {
        const response = await fetch(`${started.url}/`, {
          headers: { accept: 'text/html' },
        })
        expect(response.status).toBe(503)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('WEB_ASSETS_MISSING')
      } finally {
        await started.close()
      }
    } finally {
      await rm(repository, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('uses the persisted host when the host flag is absent', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-repo-'))
    const home = await mkdtemp(join(tmpdir(), 'skillbox-web-home-'))
    try {
      await writeFile(
        join(home, 'config.json'),
        JSON.stringify({ web: { host: 'localhost', open: false } }),
      )
      const started = await startWebServer({
        repositoryRoot: repository,
        homeRoot: home,
        port: 0,
        out: () => undefined,
        err: () => undefined,
      })
      try {
        expect(started.port).toBeGreaterThan(0)
        expect(started.url).toMatch(/^http:\/\/localhost:/)
      } finally {
        await started.close()
      }
    } finally {
      await rm(repository, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})
