import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCode } from '@skillbox/core'
import {
  createDefaultInstallService,
  createDefaultRegistryClient,
  createDefaultSecurityScanner,
  createDefaultSourceParser,
  type CoreModuleLoader,
} from './loaders.js'
import type { NormalizedSource, RegistryProvider } from './types.js'

/**
 * Loader adapters over the real `@skillbox/core` exports: `parseSource`,
 * `defaultRegistry` / `resolveProvider`, `installSkill` / `clearCache`,
 * `scanSkillForSecurity`. Missing exports degrade to a typed SkillboxError
 * with a recovery hint instead of crashing.
 */

const GITHUB_SOURCE: NormalizedSource = { type: 'github', repo: 'org/repo' }

function coreLoader(module: Record<string, unknown>): CoreModuleLoader {
  return async () => module
}

/** Minimal provider double matching the core `RegistryProvider` shape. */
function providerDouble(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'github',
    search: async () => [],
    resolve: async (source) => ({ source, revision: 'abc1234' }),
    download: async () => undefined,
    getLatestRevision: async () => 'def5678',
    ...overrides,
  }
}

describe('createDefaultSourceParser', () => {
  it('throws REGISTRY_UNAVAILABLE with a recovery hint when core has no parser', async () => {
    const parser = createDefaultSourceParser(coreLoader({}))
    await expect(parser.parse('github:org/repo')).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
  })

  it('adapts the real parseSource free-function export', async () => {
    const parser = createDefaultSourceParser(
      coreLoader({ parseSource: (source: string) => ({ type: 'github', repo: source }) }),
    )
    expect(await parser.parse('org/repo')).toEqual({ type: 'github', repo: 'org/repo' })
  })

  it('falls back to a SourceParser class export', async () => {
    const parser = createDefaultSourceParser(
      coreLoader({
        SourceParser: class {
          parse(source: string): NormalizedSource {
            return { type: 'local', path: source }
          }
        },
      }),
    )
    expect(await parser.parse('./skills/x')).toEqual({ type: 'local', path: './skills/x' })
  })
})

describe('createDefaultRegistryClient', () => {
  it('throws REGISTRY_UNAVAILABLE when the registry module has not landed', async () => {
    const client = createDefaultRegistryClient('/home/x', coreLoader({}))
    await expect(client.search('react')).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
    await expect(client.resolve(GITHUB_SOURCE)).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
    await expect(client.getLatestRevision(GITHUB_SOURCE)).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
    await expect(client.providerFor(GITHUB_SOURCE)).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
  })

  it('aggregates provider search hits over core defaultRegistry', async () => {
    const github = providerDouble({
      search: async () => [
        { name: 'a', source: 'github:org/a', popularity: 10, security: 'unknown', description: '' },
      ],
    })
    const skillsSh = providerDouble({
      id: 'skills-sh',
      search: async () => [
        {
          name: 'b',
          source: 'skills-sh:org/b',
          popularity: 5,
          security: 'reviewed',
          description: '',
        },
      ],
    })
    const client = createDefaultRegistryClient(
      '/home/x',
      coreLoader({
        defaultRegistry: { listProviders: () => [github, skillsSh] },
        resolveProvider: () => github,
      }),
    )
    expect(await client.search('react')).toEqual([
      { name: 'a', source: 'github:org/a', popularity: 10, security: 'unknown', description: '' },
      {
        name: 'b',
        source: 'skills-sh:org/b',
        popularity: 5,
        security: 'reviewed',
        description: '',
      },
    ])
  })

  it('dispatches resolve/getLatestRevision/providerFor through core resolveProvider', async () => {
    const github = providerDouble()
    const client = createDefaultRegistryClient(
      '/home/x',
      coreLoader({
        defaultRegistry: { listProviders: () => [github] },
        resolveProvider: (sourceType: string) => {
          if (sourceType !== 'github') {
            throw new Error(`no provider for ${sourceType}`)
          }
          return github
        },
      }),
    )
    expect(await client.resolve(GITHUB_SOURCE)).toEqual({
      source: GITHUB_SOURCE,
      revision: 'abc1234',
    })
    expect(await client.getLatestRevision(GITHUB_SOURCE)).toBe('def5678')
    expect(await client.providerFor(GITHUB_SOURCE)).toBe(github)
  })

  it('throws REGISTRY_UNAVAILABLE when resolveProvider has not landed', async () => {
    const client = createDefaultRegistryClient(
      '/home/x',
      coreLoader({ defaultRegistry: { listProviders: () => [providerDouble()] } }),
    )
    await expect(client.resolve(GITHUB_SOURCE)).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
    await expect(client.getLatestRevision(GITHUB_SOURCE)).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
  })

  it('registers the default providers once and aggregates their search hits', async () => {
    const registerCalls: string[] = []
    const registered: RegistryProvider[] = []
    const githubHit = {
      name: 'a',
      source: 'github:org/a',
      popularity: 10,
      security: 'unknown' as const,
      description: '',
    }
    const skillsShHit = {
      name: 'b',
      source: 'skills-sh:org/b',
      popularity: 5,
      security: 'reviewed' as const,
      description: '',
    }
    const localHit = {
      name: 'c',
      source: 'local:/tmp/c',
      popularity: 1,
      security: 'unknown' as const,
      description: '',
    }
    const github = providerDouble({ id: 'github', search: async () => [githubHit] })
    const skillsSh = providerDouble({ id: 'skills-sh', search: async () => [skillsShHit] })
    const local = providerDouble({ id: 'local', search: async () => [localHit] })
    const client = createDefaultRegistryClient(
      '/home/x',
      coreLoader({
        defaultRegistry: { listProviders: () => [...registered] },
        registerProvider: (provider: RegistryProvider) => {
          registerCalls.push(provider.id)
          registered.push(provider)
        },
        GitHubProvider: class {
          constructor() {
            return github
          }
        },
        SkillsShProvider: class {
          constructor() {
            return skillsSh
          }
        },
        LocalProvider: class {
          constructor() {
            return local
          }
        },
      }),
    )
    // First search: the providers register lazily, then their hits aggregate.
    expect(await client.search('react')).toEqual([githubHit, skillsShHit, localHit])
    expect(registerCalls).toEqual(['github', 'skills-sh', 'local'])
    // Registration is one-shot: a second search must not re-register.
    expect(await client.search('react')).toEqual([githubHit, skillsShHit, localHit])
    expect(registerCalls).toEqual(['github', 'skills-sh', 'local'])
  })

  it('skips registration silently when core lacks the provider exports', async () => {
    const hit = {
      name: 'a',
      source: 'github:org/a',
      popularity: 10,
      security: 'unknown' as const,
      description: '',
    }
    const client = createDefaultRegistryClient(
      '/home/x',
      coreLoader({
        defaultRegistry: {
          listProviders: () => [providerDouble({ search: async () => [hit] })],
        },
      }),
    )
    // No GitHubProvider/SkillsShProvider/LocalProvider/registerProvider in the
    // module → the registration is skipped and search still aggregates.
    expect(await client.search('react')).toEqual([hit])
  })

  it('degrades per-provider: one failing search must not kill the aggregation', async () => {
    const hit = {
      name: 'b',
      source: 'skills-sh:org/b',
      popularity: 5,
      security: 'reviewed' as const,
      description: '',
    }
    const flaky = providerDouble({
      id: 'github',
      search: async () => {
        throw new Error('rate limited')
      },
    })
    const healthy = providerDouble({ id: 'skills-sh', search: async () => [hit] })
    const client = createDefaultRegistryClient(
      '/home/x',
      coreLoader({ defaultRegistry: { listProviders: () => [flaky, healthy] } }),
    )
    expect(await client.search('react')).toEqual([hit])
  })
})

describe('createDefaultInstallService', () => {
  const options = { repositoryRoot: '/repo', homeRoot: '/home' }

  it('throws INSTALL_DOWNLOAD_FAILED when the install module has not landed', async () => {
    const installer = createDefaultInstallService(options, coreLoader({}))
    await expect(
      installer.installSkill({ source: GITHUB_SOURCE, repositoryRoot: '/repo' }),
    ).rejects.toMatchObject({ code: ErrorCode.INSTALL_DOWNLOAD_FAILED })
    await expect(
      installer.updateSkill({ name: 'x', source: GITHUB_SOURCE, repositoryRoot: '/repo' }),
    ).rejects.toMatchObject({ code: ErrorCode.INSTALL_DOWNLOAD_FAILED })
  })

  it('throws CACHE_MISS for cache clean when the cache module has not landed', async () => {
    const installer = createDefaultInstallService(options, coreLoader({}))
    await expect(installer.clearCache()).rejects.toMatchObject({
      code: ErrorCode.CACHE_MISS,
    })
  })

  it('maps the CLI input onto core installSkill(source, options)', async () => {
    const calls: Array<{ source: unknown; options: Record<string, unknown> }> = []
    const provider = providerDouble()
    const installer = createDefaultInstallService(
      options,
      coreLoader({
        installSkill: async (source: unknown, opts: unknown) => {
          calls.push({ source, options: opts as Record<string, unknown> })
          return {
            alias: 'foo',
            mode: 'managed',
            source,
            revision: 'abc1234',
            integrity: 'sha256:x',
            security: { risk: 'low', scannedAt: 'now' },
            agents: ['claude'],
            materializedPath: '/lib/foo',
            cacheHit: false,
          }
        },
      }),
    )
    const result = await installer.installSkill({
      source: GITHUB_SOURCE,
      alias: 'foo',
      targetAgents: ['claude'],
      allowHighRisk: true,
      provider,
      repositoryRoot: '/repo',
      homeRoot: '/home',
    })
    expect(result.alias).toBe('foo')
    expect(result.revision).toBe('abc1234')
    expect(result.agents).toEqual(['claude'])
    expect(calls[0]?.source).toEqual(GITHUB_SOURCE)
    expect(calls[0]?.options).toMatchObject({
      repositoryRoot: '/repo',
      provider,
      alias: 'foo',
      targetAgents: ['claude'],
      allowPolicy: { allowHighRisk: true },
      homeRoot: '/home',
    })
  })

  it('omits the allowPolicy when no high-risk override is granted', async () => {
    let received: Record<string, unknown> | undefined
    const installer = createDefaultInstallService(
      options,
      coreLoader({
        installSkill: async (_source: unknown, opts: unknown) => {
          received = opts as Record<string, unknown>
          return { alias: 'foo', mode: 'managed', revision: 'abc', integrity: 'h', agents: [] }
        },
      }),
    )
    await installer.installSkill({
      source: GITHUB_SOURCE,
      repositoryRoot: '/repo',
      allowHighRisk: false,
    })
    expect(received?.allowPolicy).toBeUndefined()
  })

  it('delegates updateSkill when core exports it', async () => {
    const calls: Array<{ source: unknown; options: Record<string, unknown> }> = []
    const installer = createDefaultInstallService(
      options,
      coreLoader({
        updateSkill: async (source: unknown, opts: unknown) => {
          calls.push({ source, options: opts as Record<string, unknown> })
        },
      }),
    )
    await installer.updateSkill({
      name: 'foo',
      source: GITHUB_SOURCE,
      allowHighRisk: true,
      repositoryRoot: '/repo',
    })
    expect(calls[0]?.source).toEqual(GITHUB_SOURCE)
    expect(calls[0]?.options).toMatchObject({
      repositoryRoot: '/repo',
      alias: 'foo',
      allowPolicy: { allowHighRisk: true },
    })
  })

  it('reports the update flow as unavailable until core updateSkill lands', async () => {
    const installer = createDefaultInstallService(
      options,
      coreLoader({ installSkill: async () => ({}) }),
    )
    await expect(
      installer.updateSkill({ name: 'foo', source: GITHUB_SOURCE, repositoryRoot: '/repo' }),
    ).rejects.toMatchObject({
      code: ErrorCode.INSTALL_DOWNLOAD_FAILED,
    })
  })

  it('counts cache entries before clearing and reports them (core clearCache returns void)', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cache-test-'))
    try {
      const homeRoot = path.join(base, 'home')
      const cacheRoot = path.join(homeRoot, 'cache')
      // Two entries plus a transient partial staging dir (not counted).
      await fs.mkdir(path.join(cacheRoot, 'aaaa1111', 'rev-one'), { recursive: true })
      await fs.mkdir(path.join(cacheRoot, 'bbbb2222', 'rev-two'), { recursive: true })
      await fs.mkdir(path.join(cacheRoot, 'aaaa1111', '.partial-123'), { recursive: true })
      await fs.writeFile(path.join(cacheRoot, 'aaaa1111', 'rev-one', '.integrity'), 'sha256:x\n')

      const clearedCalls: string[] = []
      const installer = createDefaultInstallService(
        { repositoryRoot: base, homeRoot },
        coreLoader({
          buildSkillboxHomeLayout: (root: string) => ({ cache: path.join(root, 'cache') }),
          clearCache: async (clearedHome?: string) => {
            clearedCalls.push(clearedHome ?? '')
            await fs.rm(path.join(homeRoot, 'cache'), { recursive: true, force: true })
          },
        }),
      )
      const outcome = await installer.clearCache()
      expect(outcome.cleared).toBe(2)
      expect(clearedCalls).toEqual([homeRoot])
      // The cache was actually emptied.
      await expect(fs.readdir(cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('reports 0 and skips the clear when the cache is empty', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cache-test-'))
    try {
      const homeRoot = path.join(base, 'home')
      await fs.mkdir(homeRoot)
      const clearedCalls: string[] = []
      const installer = createDefaultInstallService(
        { repositoryRoot: base, homeRoot },
        coreLoader({
          buildSkillboxHomeLayout: (root: string) => ({ cache: path.join(root, 'cache') }),
          clearCache: async (clearedHome?: string) => {
            clearedCalls.push(clearedHome ?? '')
          },
        }),
      )
      expect(await installer.clearCache()).toEqual({ cleared: 0 })
      expect(clearedCalls).toHaveLength(0)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})

describe('createDefaultSecurityScanner', () => {
  it('throws INSTALL_DOWNLOAD_FAILED when the scanner has not landed', async () => {
    const scanner = createDefaultSecurityScanner(coreLoader({}))
    await expect(scanner.scan('/tmp/x')).rejects.toMatchObject({
      code: ErrorCode.INSTALL_DOWNLOAD_FAILED,
    })
  })

  it('delegates to core scanSkillForSecurity', async () => {
    const scanned: string[] = []
    const scanner = createDefaultSecurityScanner(
      coreLoader({
        scanSkillForSecurity: async (dir: string) => {
          scanned.push(dir)
          return { risk: 'low', findings: [], filesScanned: 3, block: false }
        },
      }),
    )
    expect(await scanner.scan('/tmp/skill')).toEqual({
      risk: 'low',
      findings: [],
      filesScanned: 3,
      block: false,
    })
    expect(scanned).toEqual(['/tmp/skill'])
  })
})
