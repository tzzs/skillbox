import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api.js'

afterEach(() => vi.unstubAllGlobals())

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('sync API client', () => {
  it('uses presentation DTOs for sync and conflict requests', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ sync: { kind: 'completed', automaticallyMerged: 2, retriedPushes: 0 } }),
      )
      .mockResolvedValueOnce(
        response({
          conflict: {
            id: 'session 1',
            snapshotId: 'restore-1',
            createdAt: 'now',
            expiresAt: 'later',
            conflicts: [],
          },
        }),
      )
    vi.stubGlobal('fetch', fetch)

    await expect(api.sync()).resolves.toMatchObject({ kind: 'completed', automaticallyMerged: 2 })
    await expect(api.conflict('session 1')).resolves.toMatchObject({ snapshotId: 'restore-1' })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/sync')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/conflicts/session%201')
  })

  it('submits only user choices when resolving a session', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ sync: { kind: 'idle' } }))
    vi.stubGlobal('fetch', fetch)

    await api.resolveConflicts('session', { resolutions: { c1: 'keep-both' } })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/conflicts/session/resolve')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ resolutions: { c1: 'keep-both' } }),
    })
  })

  it('treats a conflict response as an actionable sync outcome, not a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          {
            sync: {
              kind: 'conflicts',
              sessionId: 'session',
              conflictCount: 1,
              snapshotId: 'restore-1',
            },
          },
          409,
        ),
      ),
    )

    await expect(api.sync()).resolves.toMatchObject({
      kind: 'conflicts',
      sessionId: 'session',
    })
  })

  it('keeps a safely blocked sync available to the UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          {
            sync: {
              kind: 'blocked',
              reason: 'operation-locked',
              message: 'Try again soon.',
              retryable: true,
            },
          },
          423,
        ),
      ),
    )

    await expect(api.sync()).resolves.toMatchObject({ kind: 'blocked', retryable: true })
  })
})

describe('lifecycle API client', () => {
  it('uses the Core-backed lifecycle and operation routes', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ forked: { alias: 'hello', mode: 'forked' } }))
      .mockResolvedValueOnce(response({ merge: { name: 'hello', conflicts: [] } }))
      .mockResolvedValueOnce(response({ rollback: { operationId: 'op-1', restoredTargets: [] } }))
    vi.stubGlobal('fetch', fetch)

    await expect(api.forkSkill('hello world')).resolves.toMatchObject({ mode: 'forked' })
    await expect(api.mergeSkill('hello world')).resolves.toMatchObject({ name: 'hello' })
    await expect(api.rollbackOperation('op-1')).resolves.toMatchObject({ operationId: 'op-1' })

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/skills/hello%20world/fork')
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/skills/hello%20world/merge')
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/operations/rollback')
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ operationId: 'op-1' }),
    })
  })
})
