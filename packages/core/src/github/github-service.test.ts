import { describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import { RuntimeConfigService } from '../runtime/config.js'
import { MemoryCredentialStore } from './credential-store.js'
import { TokenStore } from './token-store.js'
import { GitHubConfigStore } from './config.js'
import { GitHubService } from './github-service.js'
import { GitHubError, GitHubErrorCode } from './errors.js'
import { DEFAULT_REPOSITORY_NAME } from './types.js'
import type { GitHubApi } from './api.js'
import type { GitHubUser, GitHubRepository, TokenRecord } from './types.js'
import { withTempDir } from '../fs/test-utils.js'

const NOW = 1_500_000

const user: GitHubUser = {
  id: 1,
  login: 'octocat',
  name: 'Octo Cat',
  htmlUrl: 'https://github.com/octocat',
}

const repository: GitHubRepository = {
  id: 1,
  name: DEFAULT_REPOSITORY_NAME,
  owner: 'octocat',
  fullName: 'octocat/skillbox-skills',
  private: true,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/octocat/skillbox-skills',
  cloneUrl: 'https://github.com/octocat/skillbox-skills.git',
}

const validRecord: TokenRecord = {
  accessToken: 'ghu_access',
  tokenType: 'bearer',
  refreshToken: 'ghu_refresh',
  expiresAt: NOW + 60_000,
  refreshTokenExpiresAt: NOW + 60_000_000,
}

function apiMock(): { api: GitHubApi; calls: { getCurrentUser: ReturnType<typeof vi.fn> } } {
  const calls = {
    getCurrentUser: vi.fn<GitHubApi['getCurrentUser']>().mockResolvedValue(user),
  }
  const api = {
    getCurrentUser: calls.getCurrentUser,
    createRepository: vi.fn(),
    getRepository: vi.fn(),
    listRepositories: vi.fn(),
    refreshAccessToken: vi.fn(),
    requestDeviceCode: vi.fn<GitHubApi['requestDeviceCode']>().mockResolvedValue({
      deviceCode: 'device-1',
      userCode: 'AAAA-BBBB',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
      createdAt: 0,
    }),
    pollAccessToken: vi.fn<GitHubApi['pollAccessToken']>().mockResolvedValue({ status: 'pending' }),
  } as unknown as GitHubApi
  return { api, calls }
}

function makeService(
  dir: string,
  api: GitHubApi,
  now = NOW,
): { service: GitHubService; tokenStore: TokenStore; configStore: GitHubConfigStore } {
  const tokenStore = new TokenStore({ store: new MemoryCredentialStore(), now: () => now })
  const configStore = new GitHubConfigStore(
    new RuntimeConfigService({ configFilePath: path.join(dir, 'config.json') }),
  )
  const service = new GitHubService({
    clientId: 'test-client-id',
    api,
    tokenStore,
    configStore,
    now: () => now,
  })
  return { service, tokenStore, configStore }
}

function reuseError(): GitHubError {
  return new GitHubError(GitHubErrorCode.GITHUB_API_ERROR, 'name already exists on this account', {
    reason: 'http',
    context: { status: 422, body: { message: 'name already exists on this account' } },
  })
}

describe('GitHubService.getConnectionState', () => {
  it('reports not-connected with no token and no metadata', async () => {
    await withTempDir(async (dir) => {
      const { service } = makeService(dir, apiMock().api)
      expect(await service.getConnectionState()).toEqual({
        state: 'not-connected',
        connected: false,
      })
    })
  })

  it('reports authorizing while a device flow is active', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      const { service } = makeService(dir, api)
      await service.startDeviceAuthorization()
      const snapshot = await service.getConnectionState()
      expect(snapshot.state).toBe('authorizing')
    })
  })

  it('degrades to reauthorization-required when config claims a connection but no token is stored', async () => {
    await withTempDir(async (dir) => {
      const { service, configStore } = makeService(dir, apiMock().api)
      await configStore.writeConnected({ login: 'octocat', provider: 'github-app' })
      expect(await service.getConnectionState()).toEqual({
        state: 'reauthorization-required',
        connected: true,
        login: 'octocat',
        provider: 'github-app',
      })
    })
  })

  it('reports connected with a valid stored token', async () => {
    await withTempDir(async (dir) => {
      const { service, tokenStore, configStore } = makeService(dir, apiMock().api)
      await configStore.writeConnected({ login: 'octocat', provider: 'github-app' })
      await tokenStore.save(validRecord)
      expect(await service.getConnectionState()).toMatchObject({
        state: 'connected',
        connected: true,
        login: 'octocat',
      })
    })
  })

  it('reports refresh-required when only the refresh token is still usable', async () => {
    await withTempDir(async (dir) => {
      const { service, tokenStore } = makeService(dir, apiMock().api)
      await tokenStore.save({ ...validRecord, expiresAt: NOW - 1 })
      expect((await service.getConnectionState()).state).toBe('refresh-required')
    })
  })
})

describe('GitHubService device authorization', () => {
  it('starts the flow and delegates the shown payload', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      const requestDeviceCode = vi.fn<GitHubApi['requestDeviceCode']>().mockResolvedValue({
        deviceCode: 'device-1',
        userCode: 'AAAA-BBBB',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
        createdAt: 0,
      })
      ;(api.requestDeviceCode as ReturnType<typeof vi.fn>).mockImplementation(requestDeviceCode)
      const { service } = makeService(dir, api)
      const device = await service.startDeviceAuthorization()
      expect(device.userCode).toBe('AAAA-BBBB')
    })
  })

  it('verifies the user and persists connection metadata on authorization', async () => {
    await withTempDir(async (dir) => {
      const { api, calls } = apiMock()
      ;(api.pollAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'authorized',
        record: validRecord,
      })
      const { service, configStore, tokenStore } = makeService(dir, api)
      await service.startDeviceAuthorization()
      const result = await service.pollDeviceAuthorization()
      expect(result.status).toBe('authorized')
      expect(calls.getCurrentUser).toHaveBeenCalledWith(validRecord.accessToken)
      const meta = await configStore.read()
      expect(meta).toEqual({ connected: true, login: 'octocat', provider: 'github-app' })
      expect(await tokenStore.read()).toEqual(validRecord)
    })
  })

  it('does not write metadata while the flow is still pending', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.pollAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'pending' })
      const { service, configStore } = makeService(dir, api)
      await service.startDeviceAuthorization()
      await service.pollDeviceAuthorization()
      expect((await configStore.read()).connected).toBe(false)
    })
  })

  it('cancel resets the flow and the connection state', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.pollAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'pending' })
      const { service } = makeService(dir, api)
      await service.startDeviceAuthorization()
      expect((await service.getConnectionState()).state).toBe('authorizing')
      await service.cancelDeviceAuthorization()
      expect((await service.getConnectionState()).state).toBe('not-connected')
    })
  })
})

describe('GitHubService authenticated operations', () => {
  it('throws GITHUB_NOT_CONNECTED when no token is stored', async () => {
    await withTempDir(async (dir) => {
      const { service } = makeService(dir, apiMock().api)
      await expect(service.getCurrentUser()).rejects.toMatchObject({
        code: GitHubErrorCode.GITHUB_NOT_CONNECTED,
      })
    })
  })

  it('refreshes silently before an operation when the access token is stale', async () => {
    await withTempDir(async (dir) => {
      const { api, calls } = apiMock()
      const refreshed: TokenRecord = {
        ...validRecord,
        accessToken: 'ghu_fresh',
        expiresAt: NOW + 50_000,
      }
      const refreshAccessToken = vi
        .fn<GitHubApi['refreshAccessToken']>()
        .mockResolvedValue(refreshed)
      ;(api.refreshAccessToken as ReturnType<typeof vi.fn>).mockImplementation(refreshAccessToken)
      const { service, tokenStore } = makeService(dir, api)
      await tokenStore.save({ ...validRecord, expiresAt: NOW - 1 })
      await service.getCurrentUser()
      expect(calls.getCurrentUser).toHaveBeenCalledWith('ghu_fresh')
      expect(await tokenStore.read()).toEqual(refreshed)
    })
  })

  it('throws reauthorization when a silent refresh fails', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValue(
        new GitHubError(GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED, 'invalid_grant', {
          reason: 'oauth',
        }),
      )
      const { service, tokenStore } = makeService(dir, api)
      await tokenStore.save({ ...validRecord, expiresAt: NOW - 1 })
      await expect(service.getCurrentUser()).rejects.toMatchObject({
        code: GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED,
      })
    })
  })

  it('uses the stored token directly while it is valid', async () => {
    await withTempDir(async (dir) => {
      const { api, calls } = apiMock()
      const { service, tokenStore } = makeService(dir, api)
      await tokenStore.save(validRecord)
      await service.getCurrentUser()
      expect(calls.getCurrentUser).toHaveBeenCalledWith(validRecord.accessToken)
      expect(api.refreshAccessToken).not.toHaveBeenCalled()
    })
  })
})

describe('GitHubService.ensureRepository', () => {
  it('resolves a repository without persisting its binding until explicitly bound', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.createRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository)
      const { service, configStore, tokenStore } = makeService(dir, api)
      await tokenStore.save(validRecord)
      await configStore.writeConnected({ login: 'octocat', provider: 'github-app' })

      const result = await service.resolveRepository()
      expect(result).toEqual({ repository, reused: false })
      expect((await configStore.read()).repository).toBeUndefined()

      await service.bindRepository(repository)
      expect((await configStore.read()).repository).toBe(repository.fullName)
    })
  })

  it('creates a private repository and rebinds the config', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.createRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository)
      const { service, configStore, tokenStore } = makeService(dir, api)
      await tokenStore.save(validRecord)
      const result = await service.ensureRepository()
      expect(result).toEqual({ repository, reused: false })
      expect(api.createRepository).toHaveBeenCalledWith(validRecord.accessToken, {
        name: DEFAULT_REPOSITORY_NAME,
        private: true,
        defaultBranch: 'main',
      })
      expect(await configStore.read()).toMatchObject({
        connected: true,
        login: 'octocat',
        repository: 'octocat/skillbox-skills',
      })
    })
  })

  it('reuses an existing repository after an already_exists collision', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.createRepository as ReturnType<typeof vi.fn>).mockRejectedValue(reuseError())
      ;(api.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository)
      const { service, tokenStore } = makeService(dir, api)
      await tokenStore.save(validRecord)
      const result = await service.ensureRepository()
      expect(result).toEqual({ repository, reused: true })
      expect(api.getRepository).toHaveBeenCalledWith(
        validRecord.accessToken,
        'octocat',
        DEFAULT_REPOSITORY_NAME,
      )
    })
  })

  it('rethrows when the colliding repository vanishes before the lookup', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.createRepository as ReturnType<typeof vi.fn>).mockRejectedValue(reuseError())
      ;(api.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      const { service, tokenStore } = makeService(dir, api)
      await tokenStore.save(validRecord)
      await expect(service.ensureRepository()).rejects.toMatchObject({
        message: 'name already exists on this account',
      })
    })
  })

  it('reuses an existing repo before any connection metadata exists', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.createRepository as ReturnType<typeof vi.fn>).mockRejectedValue(reuseError())
      ;(api.getRepository as ReturnType<typeof vi.fn>).mockResolvedValue(repository)
      const { service, tokenStore } = makeService(dir, api)
      await tokenStore.save(validRecord)
      const result = await service.ensureRepository({ name: 'custom-name' })
      expect(result.reused).toBe(true)
      expect(api.getRepository).toHaveBeenCalledWith(
        validRecord.accessToken,
        'octocat',
        'custom-name',
      )
    })
  })
})

describe('GitHubService.selectRepository / refreshTokens / disconnect', () => {
  it('binds an existing repository for the selection flow', async () => {
    await withTempDir(async (dir) => {
      const { service, configStore } = makeService(dir, apiMock().api)
      await service.selectRepository(repository)
      expect(await configStore.read()).toEqual({
        connected: true,
        login: 'octocat',
        provider: 'github-app',
        repository: 'octocat/skillbox-skills',
      })
    })
  })

  it('maps refresh outcomes back to authorization states', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.refreshAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(validRecord)
      const { service, tokenStore } = makeService(dir, api)
      await tokenStore.save(validRecord)
      expect(await service.refreshTokens()).toBe('connected')

      ;(api.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValue(
        new GitHubError(GitHubErrorCode.GITHUB_REAUTHORIZATION_REQUIRED, 'invalid_grant', {
          reason: 'oauth',
        }),
      )
      expect(await service.refreshTokens()).toBe('reauthorization-required')
    })
  })

  it('disconnect clears tokens and metadata without touching the repository', async () => {
    await withTempDir(async (dir) => {
      const { api } = apiMock()
      ;(api.pollAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'pending' })
      const { service, tokenStore, configStore } = makeService(dir, api)
      await configStore.writeConnected({
        login: 'octocat',
        provider: 'github-app',
        repository: 'octocat/skillbox-skills',
      })
      await tokenStore.save(validRecord)
      await service.startDeviceAuthorization()
      await service.disconnect()
      expect(await tokenStore.read()).toBeNull()
      expect((await configStore.read()).connected).toBe(false)
      expect((await service.getConnectionState()).state).toBe('not-connected')
    })
  })
})
