import { describe, expect, it, vi } from 'vitest'
import { DeviceFlowService } from './device-flow.js'
import { GitHubErrorCode } from './errors.js'
import { MemoryCredentialStore } from './credential-store.js'
import { TokenStore } from './token-store.js'
import type { GitHubApi } from './api.js'
import type { DeviceAuthorization, DevicePollResult, TokenRecord } from './types.js'

const device: DeviceAuthorization = {
  deviceCode: 'device-123',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
  createdAt: 0,
}

const record: TokenRecord = {
  accessToken: 'ghu_access',
  tokenType: 'bearer',
  refreshToken: 'ghu_refresh',
  expiresAt: 9_000_000,
}

function makeService(
  poll: (deviceCode: string) => Promise<DevicePollResult> | DevicePollResult,
  opts: { scope?: string; deviceCode?: () => Promise<DeviceAuthorization> } = {},
) {
  const api = {
    requestDeviceCode: vi.fn(opts.deviceCode ?? (async () => device)),
    pollAccessToken: vi.fn(async (deviceCode: string) => poll(deviceCode)),
  } as unknown as GitHubApi
  const tokenStore = new TokenStore({ store: new MemoryCredentialStore() })
  const options: { api: GitHubApi; tokenStore: TokenStore } & { scope?: string } = {
    api,
    tokenStore,
  }
  if (opts.scope !== undefined) {
    options.scope = opts.scope
  }
  return { api, tokenStore, service: new DeviceFlowService(options) }
}

describe('DeviceFlowService', () => {
  it('enters authorizing after start and surfaces the user-facing payload', async () => {
    const { api, service } = makeService(async () => ({ status: 'pending' }))
    const result = await service.startAuthorization()
    expect(api.requestDeviceCode).toHaveBeenCalledWith('repo')
    expect(result).toEqual(device)
    expect(service.state).toBe('authorizing')
    expect(service.active).toBe(true)
    expect(service.intervalSeconds).toBe(device.interval)
  })

  it('requests a custom scope when configured', async () => {
    const { api, service } = makeService(async () => ({ status: 'pending' }), {
      scope: 'repo,workflow',
    })
    await service.startAuthorization()
    expect(api.requestDeviceCode).toHaveBeenCalledWith('repo,workflow')
  })

  it('rejects polling before a flow was started', async () => {
    const { service } = makeService(async () => ({ status: 'pending' }))
    await expect(service.pollAuthorization()).rejects.toMatchObject({
      code: GitHubErrorCode.GITHUB_NOT_CONNECTED,
    })
    expect(service.state).toBe('not-connected')
  })

  it('persists the token record and becomes connected on authorization', async () => {
    const { tokenStore, service } = makeService(async () => ({ status: 'authorized', record }))
    await service.startAuthorization()
    const result = await service.pollAuthorization()
    expect(result).toEqual({ status: 'authorized', record })
    expect(await tokenStore.read()).toEqual(record)
    expect(service.state).toBe('connected')
    expect(service.active).toBe(false)
  })

  it('keeps the flow on pending', async () => {
    const { service } = makeService(async () => ({ status: 'pending' }))
    await service.startAuthorization()
    const result = await service.pollAuthorization()
    expect(result).toEqual({ status: 'pending' })
    expect(service.state).toBe('authorizing')
    expect(service.active).toBe(true)
  })

  it('honours slow_down and updates the poll interval', async () => {
    const { service } = makeService(async () => ({ status: 'slow-down', interval: 12 }))
    await service.startAuthorization()
    const result = await service.pollAuthorization()
    expect(result).toEqual({ status: 'slow-down', interval: 12 })
    expect(service.intervalSeconds).toBe(12)
    expect(service.state).toBe('authorizing')
  })

  it('maps expired_token to refresh-required and clears the flow', async () => {
    const { service } = makeService(async () => ({ status: 'expired' }))
    await service.startAuthorization()
    const result = await service.pollAuthorization()
    expect(result).toEqual({ status: 'expired' })
    expect(service.state).toBe('refresh-required')
    expect(service.active).toBe(false)
  })

  it('returns to not-connected on denied and failed outcomes', async () => {
    const denied = makeService(async () => ({ status: 'denied' }))
    await denied.service.startAuthorization()
    expect((await denied.service.pollAuthorization()).status).toBe('denied')
    expect(denied.service.state).toBe('not-connected')
    expect(denied.service.active).toBe(false)

    const failed = makeService(async () => ({ status: 'failed', message: 'boom' }))
    await failed.service.startAuthorization()
    expect((await failed.service.pollAuthorization()).status).toBe('failed')
    expect(failed.service.state).toBe('not-connected')
  })

  it('cancel aborts the flow without touching the token store or local state', async () => {
    const { tokenStore, service } = makeService(async () => ({ status: 'pending' }))
    await service.startAuthorization()
    service.cancel()
    expect(service.state).toBe('not-connected')
    expect(service.active).toBe(false)
    expect(await tokenStore.read()).toBeNull()
  })
})
