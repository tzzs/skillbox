import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createCliHarness, workspaceRootOf, type CliHarness } from './cli-harness.js'
import { runGit } from './git-fixture.js'

/**
 * Hermetic GitHub connect journey (roadmap 3.2): a local HTTP server stands
 * in for the GitHub device-flow + API, so `skillbox connect` completes the
 * full authorization → repository create → git bind path with no network.
 * Requires the workspace to be built; self-skips otherwise.
 */
const workspaceRoot = workspaceRootOf(import.meta.url)
const cliUnbuilt = !fsSync.existsSync(
  path.join(workspaceRoot, 'packages', 'cli', 'dist', 'index.js'),
)

describe.skipIf(cliUnbuilt)('Hermetic CLI E2E (github connect)', () => {
  let cli: CliHarness
  let base: string
  let server: http.Server
  let repoDir: string
  let homeDir: string

  beforeAll(async () => {
    cli = await createCliHarness({ workspaceRoot })
    repoDir = cli.repositoryRoot
    homeDir = cli.homeRoot

    // The fake GitHub API: device flow + user + repository creation.
    const fake = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const url = req.url ?? ''
      if (req.method === 'POST' && url === '/login/device/code') {
        send(200, {
          device_code: 'device-1',
          user_code: 'ABCD-1234',
          verification_uri: `${base}/device`,
          expires_in: 600,
          interval: 0,
        })
        return
      }
      if (req.method === 'POST' && url === '/login/oauth/access_token') {
        send(200, {
          access_token: 'gho_fake_token',
          token_type: 'bearer',
          scope: 'repo',
          expires_in: 3600,
        })
        return
      }
      if (req.method === 'GET' && url === '/user') {
        send(200, { id: 1, login: 'octocat' })
        return
      }
      if (req.method === 'POST' && url === '/user/repos') {
        send(201, {
          id: 1,
          name: 'skillbox-skills',
          owner: { login: 'octocat' },
          full_name: 'octocat/skillbox-skills',
          private: true,
          default_branch: 'main',
          html_url: `${base}/octocat/skillbox-skills`,
          clone_url: `${base}/octocat/skillbox-skills.git`,
        })
        return
      }
      if (req.method === 'GET' && url.startsWith('/repos/')) {
        send(200, {
          id: 1,
          name: 'skillbox-skills',
          owner: { login: 'octocat' },
          full_name: 'octocat/skillbox-skills',
          private: true,
          default_branch: 'main',
          html_url: `${base}/octocat/skillbox-skills`,
          clone_url: `${base}/octocat/skillbox-skills.git`,
        })
        return
      }
      send(404, { message: 'not found', url })
    })
    await new Promise<void>((resolve) => {
      fake.listen(0, '127.0.0.1', () => resolve())
    })
    server = fake
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}`
  })

  it('handles a slow_down poll and still completes the device flow', async () => {
    // A dedicated server: the first access_token poll answers slow_down.
    let polls = 0
    const slowServer = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const url = req.url ?? ''
      if (req.method === 'POST' && url === '/login/device/code') {
        send(200, {
          device_code: 'device-2',
          user_code: 'EFGH-5678',
          verification_uri: `${base}/device`,
          expires_in: 600,
          interval: 0,
        })
        return
      }
      if (req.method === 'POST' && url === '/login/oauth/access_token') {
        polls += 1
        if (polls === 1) {
          send(200, { error: 'slow_down', error_description: 'poll too fast', interval: 0 })
          return
        }
        send(200, { access_token: 'gho_fake_token', token_type: 'bearer', scope: 'repo' })
        return
      }
      if (req.method === 'GET' && url === '/user') {
        send(200, { id: 1, login: 'octocat' })
        return
      }
      if (req.method === 'POST' && url === '/user/repos') {
        send(201, {
          id: 2,
          name: 'skillbox-skills',
          owner: { login: 'octocat' },
          full_name: 'octocat/skillbox-skills',
          private: true,
          default_branch: 'main',
          html_url: `${base}/octocat/skillbox-skills`,
          clone_url: `${base}/octocat/skillbox-skills.git`,
        })
        return
      }
      send(404, { message: 'not found', url })
    })
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()))
    const slowAddress = slowServer.address() as AddressInfo
    const slowBase = `http://127.0.0.1:${slowAddress.port}`
    try {
      const result = await cli.run(['connect'], {
        cwd: repoDir,
        env: {
          SKILLBOX_GITHUB_CLIENT_ID: 'test-client',
          SKILLBOX_GITHUB_API_BASE: slowBase,
          SKILLBOX_GITHUB_LOGIN_BASE: slowBase,
          SKILLBOX_CREDENTIAL_STORE: 'memory',
        },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('octocat/skillbox-skills')
      expect(polls).toBeGreaterThanOrEqual(2)
    } finally {
      await new Promise<void>((resolve) => slowServer.close(() => resolve()))
    }
  })

  it('fails cleanly when the user denies the device authorization', async () => {
    const result = await runConnectWithPollError('access_denied')
    expect(result.exitCode).toBe(1)
    expect(result.stderr + result.stdout).toContain('denied')
  })

  it('fails cleanly when the device code expires', async () => {
    const result = await runConnectWithPollError('expired_token')
    expect(result.exitCode).toBe(1)
    expect(result.stderr + result.stdout).toContain('expired')
  })

  /** Runs `skillbox connect` against a server whose first poll answers `error`. */
  async function runConnectWithPollError(
    error: 'access_denied' | 'expired_token',
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const pollServer = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const url = req.url ?? ''
      if (req.method === 'POST' && url === '/login/device/code') {
        send(200, {
          device_code: 'device-3',
          user_code: 'IJKL-9012',
          verification_uri: `${base}/device`,
          expires_in: 600,
          interval: 0,
        })
        return
      }
      if (req.method === 'POST' && url === '/login/oauth/access_token') {
        send(200, { error })
        return
      }
      send(404, { message: 'not found', url })
    })
    await new Promise<void>((resolve) => pollServer.listen(0, '127.0.0.1', () => resolve()))
    const address = pollServer.address() as AddressInfo
    const pollBase = `http://127.0.0.1:${address.port}`
    try {
      return await cli.run(['connect'], {
        cwd: repoDir,
        env: {
          SKILLBOX_GITHUB_CLIENT_ID: 'test-client',
          SKILLBOX_GITHUB_API_BASE: pollBase,
          SKILLBOX_GITHUB_LOGIN_BASE: pollBase,
          SKILLBOX_CREDENTIAL_STORE: 'memory',
        },
      })
    } finally {
      await new Promise<void>((resolve) => pollServer.close(() => resolve()))
    }
  }

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await cli.cleanup()
  })

  it('completes the device flow, creates the repository and binds origin', async () => {
    const result = await cli.run(['connect'], {
      cwd: repoDir,
      env: {
        SKILLBOX_GITHUB_CLIENT_ID: 'test-client',
        SKILLBOX_GITHUB_API_BASE: base,
        SKILLBOX_GITHUB_LOGIN_BASE: base,
        SKILLBOX_CREDENTIAL_STORE: 'memory',
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('octocat/skillbox-skills')

    // The repository was initialized and bound to origin.
    const remote = await runGit(['remote', 'get-url', 'origin'], { cwd: repoDir })
    expect(remote.exitCode).toBe(0)
    expect(remote.stdout.trim()).toBe(`${base}/octocat/skillbox-skills.git`)

    // Machine config records the connection + repository binding.
    const config = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8')) as {
      github?: { connected?: boolean; login?: string; repository?: string }
    }
    expect(config.github?.connected).toBe(true)
    expect(config.github?.login).toBe('octocat')
    expect(config.github?.repository).toBe('octocat/skillbox-skills')
  })
})
