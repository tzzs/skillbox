import { afterEach, describe, expect, it } from 'vitest'
import { createHttpFixture, type HttpFixture } from './http-fixture.js'

describe('HTTP fixture', () => {
  const fixtures: HttpFixture[] = []

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
  })

  it('serves controlled loopback responses and records requests', async () => {
    const fixture = await createHttpFixture((request) => ({
      status: request.path === '/registry' ? 200 : 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'fixture' }),
    }))
    fixtures.push(fixture)

    const response = await fetch(`${fixture.url}/registry`, { method: 'POST', body: 'query=skill' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ source: 'fixture' })
    expect(fixture.requests).toEqual([
      expect.objectContaining({ method: 'POST', path: '/registry', body: 'query=skill' }),
    ])
  })
})
