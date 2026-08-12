import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDebugBundle } from './bundle.js'

describe('createDebugBundle', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('writes a support bundle while redacting token-like fields, headers, and credential URLs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-debug-'))
    roots.push(root)
    const result = await createDebugBundle({
      repositoryRoot: path.join(root, 'repo'),
      homeRoot: path.join(root, 'home'),
      outputFile: path.join(root, 'bundle.json'),
      details: {
        token: 'super-secret-token',
        authorization: 'Bearer abc123',
        remote: 'https://alice:secret-password@example.test/org/repo.git?access_token=query-secret',
        nested: { apiKey: 'api-secret' },
      },
      collectDiagnostics: async ({ repositoryRoot }) => ({
        repositoryRoot,
        ready: true,
        checks: [],
      }),
    })

    expect(result.outputFile).toBe(path.join(root, 'bundle.json'))
    const contents = await fs.readFile(result.outputFile, 'utf8')
    expect(contents).not.toContain('super-secret-token')
    expect(contents).not.toContain('abc123')
    expect(contents).not.toContain('secret-password')
    expect(contents).not.toContain('query-secret')
    expect(contents).not.toContain('api-secret')
    expect(JSON.parse(contents).details).toMatchObject({
      token: '[REDACTED]',
      authorization: '[REDACTED]',
      remote: 'https://example.test/org/repo.git',
      nested: { apiKey: '[REDACTED]' },
    })
  })
})
