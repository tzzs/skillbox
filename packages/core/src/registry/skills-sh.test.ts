import { describe, expect, it, vi } from 'vitest'
import { GitHubProvider } from './github.js'
import { SkillsShProvider } from './skills-sh.js'
import { isRegistryError } from './errors.js'
import type { RegistryProvider } from './types.js'

const BASE = 'https://skills.sh'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(routes: Array<{ url: string; handler: () => Response }>): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.toString())
    for (const route of routes) {
      const expected = new URL(route.url)
      if (expected.pathname === url.pathname && expected.search === url.search) {
        return route.handler()
      }
    }
    return jsonResponse(404, { message: `no mock for ${url.pathname}` })
  }) as unknown as typeof fetch
}

function stubGithubProvider(overrides: Partial<RegistryProvider> = {}): GitHubProvider {
  const stub: RegistryProvider = {
    id: 'github',
    search: vi.fn(async () => []),
    resolve: vi.fn(async (source) => ({ source, revision: 'GH_HEAD_SHA' })),
    download: vi.fn(async () => undefined),
    getLatestRevision: vi.fn(async () => 'GH_HEAD_SHA'),
    ...overrides,
  }
  return stub as unknown as GitHubProvider
}

describe('SkillsShProvider.search', () => {
  it('maps registry results onto RegistrySearchResult', async () => {
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/search?q=react`,
        handler: () =>
          jsonResponse(200, {
            results: [
              {
                package: 'vercel-labs/agent-skills',
                name: 'Agent Skills',
                description: 'A collection of skills',
                popularity: 128,
                security: 'reviewed',
              },
              {
                package: 'unreviewed-skill',
                name: 'Unreviewed',
                popularity: 3,
                security: 'unknown',
              },
            ],
          }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl })
    const results = await provider.search('react')
    expect(results).toEqual([
      {
        name: 'Agent Skills',
        source: 'skills.sh/vercel-labs/agent-skills',
        popularity: 128,
        security: 'reviewed',
        description: 'A collection of skills',
      },
      {
        name: 'Unreviewed',
        source: 'skills.sh/unreviewed-skill',
        popularity: 3,
        security: 'unknown',
        description: '',
      },
    ])
  })

  it('returns an empty list for an empty query', async () => {
    const provider = new SkillsShProvider({ fetchImpl: mockFetch([]) })
    expect(await provider.search(' ')).toEqual([])
  })

  it('wraps search failures as REGISTRY_SEARCH_FAILED', async () => {
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/search?q=react`,
        handler: () => jsonResponse(500, { message: 'boom' }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl, retries: 0 })
    let caught: unknown
    try {
      await provider.search('react')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'REGISTRY_SEARCH_FAILED' })
  })
})

describe('SkillsShProvider.resolve', () => {
  it('delegates repo-backed packages to the GitHub provider', async () => {
    const github = stubGithubProvider()
    const resolveSpy = vi.spyOn(github, 'resolve')
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/packages/vercel-labs%2Fagent-skills`,
        handler: () =>
          jsonResponse(200, {
            package: 'vercel-labs/agent-skills',
            repo: 'vercel-labs/agent-skills',
            path: 'skills/react-best-practices',
            version: 'v1.2.0',
            security: 'reviewed',
          }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl, githubProvider: github })
    const resolved = await provider.resolve({
      type: 'skills-sh',
      package: 'vercel-labs/agent-skills',
    })
    expect(resolved).toEqual({
      source: { type: 'skills-sh', package: 'vercel-labs/agent-skills' },
      revision: 'GH_HEAD_SHA',
    })
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'github',
        repo: 'vercel-labs/agent-skills',
        path: 'skills/react-best-practices',
        ref: 'v1.2.0',
      }),
    )
  })

  it('falls back to the registry version for non-repo packages', async () => {
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/packages/standalone`,
        handler: () =>
          jsonResponse(200, { package: 'standalone', version: '2.0.0', security: 'unknown' }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl })
    const resolved = await provider.resolve({ type: 'skills-sh', package: 'standalone' })
    expect(resolved).toEqual({
      source: { type: 'skills-sh', package: 'standalone' },
      revision: '2.0.0',
    })
  })

  it('maps a 404 package to REGISTRY_NOT_FOUND', async () => {
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/packages/missing`,
        handler: () => jsonResponse(404, { message: 'not found' }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl })
    let caught: unknown
    try {
      await provider.resolve({ type: 'skills-sh', package: 'missing' })
    } catch (error) {
      caught = error
    }
    expect(isRegistryError(caught)).toBe(true)
    expect(caught).toMatchObject({ code: 'REGISTRY_NOT_FOUND', reason: 'not-found' })
  })
})

describe('SkillsShProvider.download', () => {
  it('delegates repo-backed downloads to the GitHub provider', async () => {
    const github = stubGithubProvider()
    const downloadSpy = vi.spyOn(github, 'download')
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/packages/pkg`,
        handler: () =>
          jsonResponse(200, {
            package: 'pkg',
            repo: 'org/repo',
            path: 'skills/foo',
            security: 'unknown',
          }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl, githubProvider: github })
    await provider.download({ type: 'skills-sh', package: 'pkg' }, 'GH_HEAD_SHA', '/tmp/target')
    expect(downloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github', repo: 'org/repo', path: 'skills/foo' }),
      'GH_HEAD_SHA',
      '/tmp/target',
    )
  })

  it('fails with REGISTRY_DOWNLOAD_FAILED when the package has no repo mapping', async () => {
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/packages/standalone`,
        handler: () => jsonResponse(200, { package: 'standalone', version: '1.0.0' }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl })
    let caught: unknown
    try {
      await provider.download({ type: 'skills-sh', package: 'standalone' }, 'latest', '/tmp/target')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'REGISTRY_DOWNLOAD_FAILED' })
  })
})

describe('SkillsShProvider.getLatestRevision / metadata / security', () => {
  it('returns the latest revision via metadata', async () => {
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/packages/pkg`,
        handler: () =>
          jsonResponse(200, { package: 'pkg', version: '3.1.0', security: 'reviewed' }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl })
    expect(await provider.getLatestRevision({ type: 'skills-sh', package: 'pkg' })).toBe('3.1.0')
  })

  it('exposes metadata and the security review state', async () => {
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/packages/pkg`,
        handler: () =>
          jsonResponse(200, {
            package: 'pkg',
            name: 'Pkg',
            description: 'desc',
            repo: 'org/repo',
            security: 'reviewed',
            popularity: 9,
          }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl })
    const metadata = await provider.getPackageMetadata('pkg')
    expect(metadata).toEqual({
      package: 'pkg',
      name: 'Pkg',
      description: 'desc',
      repo: 'org/repo',
      security: 'reviewed',
      popularity: 9,
    })
    expect(await provider.getSecurityState('pkg')).toBe('reviewed')
  })

  it('normalizes unknown security values to "unknown"', async () => {
    const fetchImpl = mockFetch([
      {
        url: `${BASE}/api/packages/pkg`,
        handler: () => jsonResponse(200, { package: 'pkg' }),
      },
    ])
    const provider = new SkillsShProvider({ fetchImpl })
    expect(await provider.getSecurityState('pkg')).toBe('unknown')
  })
})
