import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withTempDir } from '../fs/test-utils.js'
import { computeSkillIntegrity } from '../integrity/index.js'
import { GitHubProvider } from './github.js'
import { isRegistryError } from './errors.js'
import type { NormalizedSource } from './types.js'

interface Route {
  url: string
  handler: (url: URL, init?: RequestInit) => Response
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function mockFetch(routes: Route[]): typeof fetch {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.toString())
    for (const route of routes) {
      const expected = new URL(route.url)
      if (expected.pathname === url.pathname && expected.search === url.search) {
        return route.handler(url, init)
      }
    }
    return jsonResponse(404, { message: `no mock for ${url.pathname}${url.search}` })
  }) as unknown as typeof fetch
}

const githubSource = (
  extra: Partial<Extract<NormalizedSource, { type: 'github' }>> = {},
): NormalizedSource => ({
  type: 'github',
  repo: 'org/skills-repo',
  ...extra,
})

const TREE_RESPONSE = {
  sha: 'TREE_SHA',
  truncated: false,
  tree: [
    { path: 'skills/react-best-practices/SKILL.md', type: 'blob', sha: 'blob-skills-1' },
    { path: 'skills/react-best-practices/scripts/check.mjs', type: 'blob', sha: 'blob-skills-2' },
    { path: 'skills/react-best-practices/assets/logo.png', type: 'blob', sha: 'blob-skills-3' },
    { path: 'skills/other/README.md', type: 'blob', sha: 'blob-other' },
    { path: 'README.md', type: 'blob', sha: 'blob-root-readme' },
  ],
}

const BINARY_PAYLOAD = Buffer.from([0x00, 0x01, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x02]) // NUL b i n a r y SOH

function blobResponse(content: string | Buffer): { content: string; encoding: 'base64' } {
  return { content: Buffer.from(content).toString('base64'), encoding: 'base64' }
}

const BLOB_ROUTES: Record<string, string | Buffer> = {
  'blob-skills-1': '# SKILL.md\nhello world\n',
  'blob-skills-2': 'console.log("check")\n',
  'blob-skills-3': BINARY_PAYLOAD,
  'blob-other': '# other\n',
  'blob-root-readme': '# root readme\n',
}

function treeRoutes(revision: string, tree: unknown = TREE_RESPONSE): Route[] {
  return [
    {
      url: `https://api.github.com/repos/org/skills-repo/git/trees/${revision}?recursive=1`,
      handler: () => jsonResponse(200, tree),
    },
    ...Object.entries(BLOB_ROUTES).map(([sha, content]) => ({
      url: `https://api.github.com/repos/org/skills-repo/git/blobs/${sha}`,
      handler: () => jsonResponse(200, blobResponse(content)),
    })),
  ]
}

describe('GitHubProvider.resolve', () => {
  it('resolves a pinned ref to its commit sha', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/commits/main',
        handler: () => jsonResponse(200, { sha: 'COMMIT_MAIN' }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    const resolved = await provider.resolve(githubSource({ ref: 'main' }))
    expect(resolved).toEqual({ source: githubSource({ ref: 'main' }), revision: 'COMMIT_MAIN' })
  })

  it('resolves a pinned branch from source.branch', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/commits/dev',
        handler: () => jsonResponse(200, { sha: 'COMMIT_DEV' }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    const resolved = await provider.resolve(githubSource({ branch: 'dev' }))
    expect(resolved.revision).toBe('COMMIT_DEV')
  })

  it('resolves the default-branch head when no ref is pinned', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/commits',
        handler: () => jsonResponse(200, [{ sha: 'HEAD_SHA' }, { sha: 'OLDER_SHA' }]),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    expect((await provider.resolve(githubSource())).revision).toBe('HEAD_SHA')
  })

  it('maps a 404 ref to REGISTRY_NOT_FOUND', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/commits/nope',
        handler: () => jsonResponse(404, { message: 'Not Found' }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    let caught: unknown
    try {
      await provider.resolve(githubSource({ ref: 'nope' }))
    } catch (error) {
      caught = error
    }
    expect(isRegistryError(caught)).toBe(true)
    expect(caught).toMatchObject({ code: 'REGISTRY_NOT_FOUND', reason: 'not-found' })
  })

  it('wraps transport failures as REGISTRY_UNAVAILABLE (network)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const provider = new GitHubProvider({ fetchImpl, retries: 0 })
    let caught: unknown
    try {
      await provider.resolve(githubSource())
    } catch (error) {
      caught = error
    }
    expect(isRegistryError(caught)).toBe(true)
    expect(caught).toMatchObject({ code: 'REGISTRY_UNAVAILABLE', reason: 'network' })
  })

  it('maps rate-limit responses to REGISTRY_UNAVAILABLE (rate-limit, recoverable)', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/commits',
        handler: () =>
          jsonResponse(
            403,
            { message: 'API rate limit exceeded' },
            { 'x-ratelimit-remaining': '0' },
          ),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl, retries: 0 })
    let caught: unknown
    try {
      await provider.resolve(githubSource())
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      code: 'REGISTRY_UNAVAILABLE',
      reason: 'rate-limit',
      recoverable: true,
    })
  })

  it('rejects non-github sources with SOURCE_UNSUPPORTED', async () => {
    const provider = new GitHubProvider({ fetchImpl: mockFetch([]) })
    let caught: unknown
    try {
      await provider.resolve({ type: 'local', path: '/tmp/x' })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'SOURCE_UNSUPPORTED' })
  })

  it('rejects invalid repo expressions with SOURCE_INVALID', async () => {
    const provider = new GitHubProvider({ fetchImpl: mockFetch([]) })
    let caught: unknown
    try {
      await provider.resolve({ type: 'github', repo: 'not-a-repo' })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'SOURCE_INVALID' })
  })

  it('sends the bearer token header when configured', async () => {
    const seen = vi.fn()
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      seen(init)
      return jsonResponse(200, [{ sha: 'HEAD_SHA' }])
    }) as unknown as typeof fetch
    const provider = new GitHubProvider({ fetchImpl, token: 'secret-token' })
    await provider.resolve(githubSource())
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
      }),
    )
  })

  it('retries transient 5xx failures once', async () => {
    const calls = vi.fn()
    const fetchImpl = vi.fn(async () => {
      calls()
      if (calls.mock.calls.length === 1) {
        return jsonResponse(502, { message: 'bad gateway' })
      }
      return jsonResponse(200, [{ sha: 'HEAD_SHA' }])
    }) as unknown as typeof fetch
    const provider = new GitHubProvider({ fetchImpl, retries: 1, retryBackoffMs: 1 })
    const resolved = await provider.resolve(githubSource())
    expect(resolved.revision).toBe('HEAD_SHA')
    expect(calls).toHaveBeenCalledTimes(2)
  })
})

describe('GitHubProvider.getLatestRevision', () => {
  it('returns the default-branch head commit sha', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/commits',
        handler: () => jsonResponse(200, [{ sha: 'LATEST_SHA' }]),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    expect(await provider.getLatestRevision(githubSource())).toBe('LATEST_SHA')
  })
})

describe('GitHubProvider.download', () => {
  it('downloads only the skill subtree under path', async () => {
    const fetchImpl = mockFetch(treeRoutes('HEAD_SHA'))
    const provider = new GitHubProvider({ fetchImpl })
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'skill')
      await provider.download(
        githubSource({ path: 'skills/react-best-practices' }),
        'HEAD_SHA',
        target,
      )

      expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe(
        '# SKILL.md\nhello world\n',
      )
      expect(await fs.readFile(path.join(target, 'scripts/check.mjs'), 'utf8')).toBe(
        'console.log("check")\n',
      )
      // binary content round-trips byte-exact
      expect(await fs.readFile(path.join(target, 'assets/logo.png'))).toEqual(BINARY_PAYLOAD)
      // other subtrees and the repo root stay outside the download
      await expect(fs.readFile(path.join(target, 'README.md'), 'utf8')).rejects.toThrow()
      await expect(
        fs.readFile(path.join(target, '..', 'skills', 'other', 'README.md'), 'utf8'),
      ).rejects.toThrow()
    })
  })

  it('downloads the whole repository when no path is given', async () => {
    const fetchImpl = mockFetch(treeRoutes('HEAD_SHA'))
    const provider = new GitHubProvider({ fetchImpl })
    await withTempDir(async (dir) => {
      await provider.download(githubSource(), 'HEAD_SHA', dir)
      expect(await fs.readFile(path.join(dir, 'skills/other/README.md'), 'utf8')).toBe('# other\n')
      expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toBe('# root readme\n')
    })
  })

  it('downloads a single-file skill when path points at a blob', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/git/trees/HEAD_SHA?recursive=1',
        handler: () =>
          jsonResponse(200, {
            sha: 'TREE_SHA',
            truncated: false,
            tree: [{ path: 'skills/SKILL.md', type: 'blob', sha: 'blob-skills-1' }],
          }),
      },
      {
        url: 'https://api.github.com/repos/org/skills-repo/git/blobs/blob-skills-1',
        handler: () => jsonResponse(200, blobResponse('single file skill')),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    await withTempDir(async (dir) => {
      await provider.download(githubSource({ path: 'skills/SKILL.md' }), 'HEAD_SHA', dir)
      expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe('single file skill')
    })
  })

  it('reports REGISTRY_NOT_FOUND when the skill path is absent', async () => {
    const fetchImpl = mockFetch(treeRoutes('HEAD_SHA'))
    const provider = new GitHubProvider({ fetchImpl })
    await withTempDir(async (dir) => {
      let caught: unknown
      try {
        await provider.download(githubSource({ path: 'skills/missing' }), 'HEAD_SHA', dir)
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'REGISTRY_NOT_FOUND' })
    })
  })

  it('maps tree-fetch failures to REGISTRY_DOWNLOAD_FAILED', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/git/trees/HEAD_SHA?recursive=1',
        handler: () => jsonResponse(503, { message: 'unavailable' }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl, retries: 0 })
    await withTempDir(async (dir) => {
      let caught: unknown
      try {
        await provider.download(githubSource(), 'HEAD_SHA', dir)
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'REGISTRY_DOWNLOAD_FAILED' })
    })
  })

  it('rejects tree paths that try to escape the target directory', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/git/trees/HEAD_SHA?recursive=1',
        handler: () =>
          jsonResponse(200, {
            sha: 'TREE_SHA',
            truncated: false,
            tree: [{ path: 'skills/evil/../../escape', type: 'blob', sha: 'blob-other' }],
          }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    await withTempDir(async (dir) => {
      let caught: unknown
      try {
        await provider.download(githubSource({ path: 'skills/evil' }), 'HEAD_SHA', dir)
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'REGISTRY_DOWNLOAD_FAILED' })
    })
  })

  it('fails on truncated trees with REGISTRY_DOWNLOAD_FAILED', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/repos/org/skills-repo/git/trees/HEAD_SHA?recursive=1',
        handler: () => jsonResponse(200, { sha: 'TREE_SHA', truncated: true, tree: [] }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    await withTempDir(async (dir) => {
      let caught: unknown
      try {
        await provider.download(githubSource(), 'HEAD_SHA', dir)
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'REGISTRY_DOWNLOAD_FAILED' })
    })
  })

  it('produces a directory whose integrity matches computeSkillIntegrity', async () => {
    const fetchImpl = mockFetch(treeRoutes('HEAD_SHA'))
    const provider = new GitHubProvider({ fetchImpl })
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'skill')
      await provider.download(
        githubSource({ path: 'skills/react-best-practices' }),
        'HEAD_SHA',
        target,
      )
      const integrity = await computeSkillIntegrity(target)
      expect(integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    })
  })
})

describe('GitHubProvider.search', () => {
  it('maps repository search items to RegistrySearchResult', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/search/repositories?q=react&per_page=20',
        handler: () =>
          jsonResponse(200, {
            total_count: 1,
            items: [
              {
                name: 'agent-skills',
                full_name: 'Vercel-Labs/agent-skills',
                stargazers_count: 42,
                description: 'A collection of agent skills',
              },
            ],
          }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    const results = await provider.search('react')
    expect(results).toEqual([
      {
        name: 'agent-skills',
        source: 'github:vercel-labs/agent-skills',
        popularity: 42,
        security: 'unknown',
        description: 'A collection of agent skills',
      },
    ])
  })

  it('returns an empty list for an empty query', async () => {
    const provider = new GitHubProvider({ fetchImpl: mockFetch([]) })
    expect(await provider.search('   ')).toEqual([])
  })

  it('wraps search failures as REGISTRY_SEARCH_FAILED', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/search/repositories?q=react&per_page=20',
        handler: () => jsonResponse(422, { message: 'validation failed' }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl, retries: 0 })
    let caught: unknown
    try {
      await provider.search('react')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'REGISTRY_SEARCH_FAILED' })
  })

  it('rejects a malformed search response', async () => {
    const fetchImpl = mockFetch([
      {
        url: 'https://api.github.com/search/repositories?q=react&per_page=20',
        handler: () => jsonResponse(200, { total_count: 0 }),
      },
    ])
    const provider = new GitHubProvider({ fetchImpl })
    let caught: unknown
    try {
      await provider.search('react')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'REGISTRY_SEARCH_FAILED' })
  })
})
