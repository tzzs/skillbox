import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createCliHarness, workspaceRootOf, type CliHarness } from './cli-harness.js'
import { runGit } from './git-fixture.js'

/**
 * Hermetic private-remote auth journey: after `skillbox connect` persists the
 * token in the plaintext file store (cross-process), a second process runs
 * `skillbox push` against a git remote that rejects every request with 401.
 * The push fails cleanly with the auth error instead of the "not connected"
 * hint — proving the credential bridge reached the transport.
 */
const workspaceRoot = workspaceRootOf(import.meta.url)
const cliUnbuilt = !fsSync.existsSync(
  path.join(workspaceRoot, 'packages', 'cli', 'dist', 'index.js'),
)

describe.skipIf(cliUnbuilt)('Hermetic CLI E2E (private remote auth failure)', () => {
  let cli: CliHarness
  let gitAuthUrl: string
  let gitAuthServer: http.Server

  beforeAll(async () => {
    cli = await createCliHarness({ workspaceRoot })

    // A git remote that rejects every request with 401.
    gitAuthServer = http.createServer((_req, res) => {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="skillbox-test"',
        'Content-Type': 'text/plain',
      })
      res.end('Authentication required')
    })
    await new Promise<void>((resolve) => gitAuthServer.listen(0, '127.0.0.1', () => resolve()))
    const address = gitAuthServer.address() as AddressInfo
    gitAuthUrl = `http://127.0.0.1:${address.port}/private/repo.git`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => gitAuthServer.close(() => resolve()))
    await cli.cleanup()
  })

  it('connect persists the token, then push fails cleanly with the auth error', async () => {
    const base = cli.homeRoot
    const repoDir = cli.repositoryRoot
    const fakeGitHub = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const url = req.url ?? ''
      if (req.method === 'POST' && url === '/login/device/code') {
        send(200, {
          device_code: 'device-auth',
          user_code: 'MNOP-3456',
          verification_uri: `${fakeBase}/device`,
          expires_in: 600,
          interval: 0,
        })
        return
      }
      if (req.method === 'POST' && url === '/login/oauth/access_token') {
        send(200, { access_token: 'gho_auth_token', token_type: 'bearer', scope: 'repo' })
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
          html_url: `${fakeBase}/octocat/skillbox-skills`,
          clone_url: `${fakeBase}/octocat/skillbox-skills.git`,
        })
        return
      }
      send(404, { message: 'not found', url })
    })
    await new Promise<void>((resolve) => fakeGitHub.listen(0, '127.0.0.1', () => resolve()))
    const ghAddress = fakeGitHub.address() as AddressInfo
    const fakeBase = `http://127.0.0.1:${ghAddress.port}`
    const env = {
      SKILLBOX_GITHUB_CLIENT_ID: 'test-client',
      SKILLBOX_GITHUB_API_BASE: fakeBase,
      SKILLBOX_GITHUB_LOGIN_BASE: fakeBase,
      SKILLBOX_CREDENTIAL_STORE: 'file',
    }
    try {
      const connected = await cli.run(['connect'], { cwd: repoDir, env })
      expect(connected.exitCode).toBe(0)

      // The plaintext file store persisted the token across processes.
      const tokenFile = path.join(base, 'state', 'secrets', 'skillbox-github.oauth-tokens.json')
      await expect(fs.readFile(tokenFile, 'utf8')).resolves.toContain('gho_auth_token')

      // Give the repository an initial commit and point origin at a 401 remote.
      await runGit(['add', '-A'], { cwd: repoDir })
      await runGit(['commit', '--allow-empty', '-m', 'init'], { cwd: repoDir })
      const setUrl = await runGit(['remote', 'set-url', 'origin', gitAuthUrl], { cwd: repoDir })
      expect(setUrl.exitCode).toBe(0)

      const pushed = await cli.run(['push'], { cwd: repoDir, env })
      expect(pushed.exitCode).toBe(1)
      // The push reached git (the connection gate passed) and failed on auth.
      expect(pushed.stderr + pushed.stdout).not.toContain('run `skillbox connect`')
      expect(pushed.stderr + pushed.stdout).toMatch(/authentication|401|failed/i)
    } finally {
      await new Promise<void>((resolve) => fakeGitHub.close(() => resolve()))
    }
  })
})
