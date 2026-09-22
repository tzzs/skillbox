import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ErrorCode,
  ProviderRegistry,
  buildSkillboxHomeLayout,
  type InstallResult as CoreInstallResult,
  type InstallSkillOptions,
  type NormalizedSource as CoreNormalizedSource,
  type RegistryProvider as CoreRegistryProvider,
  type SecurityScanResult as CoreSecurityScanResult,
  type UpdateSkillOptions,
} from '@skillbox/core'
import {
  createDefaultInstallService,
  createDefaultRegistryClient,
  createDefaultSecurityScanner,
  createDefaultSourceParser,
  defaultMarketplaceInstallServiceDeps,
  type MarketplaceInstallServiceDeps,
  type MarketplaceRegistryClientDeps,
  type MarketplaceSecurityScannerDeps,
  type MarketplaceSourceParserDeps,
} from './loaders.js'
import type { NormalizedSource, RegistryProvider } from './types.js'

/**
 * The marketplace loader adapters over `@skillbox/core`.
 *
 * Core is called through its real signatures, so each test either injects a
 * fake for the core function the adapter uses (typed as that function's own
 * signature, returning real core result shapes) or runs the default seam
 * against a temp fixture. Errors core itself throws (`SOURCE_INVALID`,
 * `SOURCE_UNSUPPORTED`, `SKILL_NOT_FOUND`) must reach the caller unchanged.
 */

const GITHUB_SOURCE: NormalizedSource = { type: 'github', repo: 'org/repo' }

function providerDouble(
  id = 'github',
  overrides: Partial<CoreRegistryProvider> = {},
): CoreRegistryProvider {
  return {
    id,
    search: async () => [],
    resolve: async (source) => ({ source, revision: 'abc1234' }),
    download: async () => undefined,
    getLatestRevision: async () => 'def5678',
    ...overrides,
  }
}

/** A complete core `InstallResult` (what the CLI contract copies). */
function coreInstallResult(
  source: CoreNormalizedSource,
  overrides: Partial<CoreInstallResult> = {},
): CoreInstallResult {
  return {
    alias: 'foo',
    mode: 'managed',
    source,
    revision: 'abc1234',
    integrity: 'sha256:x',
    security: { risk: 'low', scannedAt: '2026-01-01T00:00:00.000Z' },
    agents: ['claude'],
    materializedPath: '/lib/foo',
    cacheHit: false,
    ...overrides,
  }
}

/**
 * Registry-client deps over a private core `ProviderRegistry`, so the tests
 * exercise core's real register/resolve semantics without mutating the
 * process-wide registry the default seam writes to.
 */
function isolatedRegistryDeps(providerFactories: readonly (() => CoreRegistryProvider)[] = []): {
  deps: MarketplaceRegistryClientDeps
  registry: ProviderRegistry
} {
  const registry = new ProviderRegistry()
  return {
    registry,
    deps: {
      listProviders: () => registry.listProviders(),
      registerProvider: (provider) => registry.registerProvider(provider),
      resolveProvider: (sourceType) => registry.resolveProvider(sourceType),
      providerFactories,
    },
  }
}

/**
 * Install-seam deps with the provider-registration side effect neutralised;
 * the core install/cache/path functions stay real unless a test overrides them.
 */
function installDeps(
  overrides: Partial<MarketplaceInstallServiceDeps> = {},
): MarketplaceInstallServiceDeps {
  return {
    ...defaultMarketplaceInstallServiceDeps,
    listProviders: () => [],
    registerProvider: () => undefined,
    providerFactories: [],
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Source parser
 * ------------------------------------------------------------------ */

describe('createDefaultSourceParser', () => {
  it('normalizes a source with the real core parseSource', async () => {
    expect(await createDefaultSourceParser().parse('org/repo')).toEqual({
      type: 'github',
      repo: 'org/repo',
    })
    expect(await createDefaultSourceParser().parse('github:org/repo@skills/x#main')).toEqual({
      type: 'github',
      repo: 'org/repo',
      path: 'skills/x',
      ref: 'main',
    })
  })

  it('delegates to the injected parseSource and returns its normalized source', async () => {
    const inputs: string[] = []
    const deps: MarketplaceSourceParserDeps = {
      parseSource: (source: string): CoreNormalizedSource => {
        inputs.push(source)
        return { type: 'local', path: source }
      },
    }
    expect(await createDefaultSourceParser(deps).parse('./skills/x')).toEqual({
      type: 'local',
      path: './skills/x',
    })
    expect(inputs).toEqual(['./skills/x'])
  })

  it('propagates the core SOURCE_INVALID error', async () => {
    await expect(createDefaultSourceParser().parse('::not-a-source::')).rejects.toMatchObject({
      code: ErrorCode.SOURCE_INVALID,
    })
  })
})

/* ------------------------------------------------------------------ *
 * Registry client
 * ------------------------------------------------------------------ */

describe('createDefaultRegistryClient', () => {
  it('aggregates provider search hits across every registered provider', async () => {
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
    const { deps, registry } = isolatedRegistryDeps()
    registry.registerProvider(providerDouble('github', { search: async () => [githubHit] }))
    registry.registerProvider(providerDouble('skills-sh', { search: async () => [skillsShHit] }))
    const client = createDefaultRegistryClient('/home/x', deps)
    expect(await client.search('react')).toEqual([githubHit, skillsShHit])
  })

  it('degrades per-provider: one failing search must not kill the aggregation', async () => {
    const hit = {
      name: 'b',
      source: 'skills-sh:org/b',
      popularity: 5,
      security: 'reviewed' as const,
      description: '',
    }
    const { deps, registry } = isolatedRegistryDeps()
    registry.registerProvider(
      providerDouble('github', {
        search: async () => {
          throw new Error('rate limited')
        },
      }),
    )
    registry.registerProvider(providerDouble('skills-sh', { search: async () => [hit] }))
    expect(await createDefaultRegistryClient('/home/x', deps).search('react')).toEqual([hit])
  })

  it('registers the default providers on demand and only once', async () => {
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
    const { deps, registry } = isolatedRegistryDeps([
      () => providerDouble('github', { search: async () => [githubHit] }),
      () => providerDouble('skills-sh', { search: async () => [skillsShHit] }),
      () => providerDouble('local', { search: async () => [localHit] }),
    ])
    const client = createDefaultRegistryClient('/home/x', deps)
    // First search: the providers register lazily, then their hits aggregate.
    expect(await client.search('react')).toEqual([githubHit, skillsShHit, localHit])
    // Registration is idempotent: a second search must not duplicate entries.
    expect(await client.search('react')).toEqual([githubHit, skillsShHit, localHit])
    expect(registry.listProviders().map((provider) => provider.id)).toEqual([
      'github',
      'skills-sh',
      'local',
    ])
  })

  it('keeps an already-registered provider instead of the default factory', async () => {
    const stub = providerDouble('github', {
      search: async () => [
        {
          name: 'stub',
          source: 'github:stub',
          popularity: 1,
          security: 'unknown',
          description: '',
        },
      ],
    })
    const replacement = providerDouble('github')
    const { deps, registry } = isolatedRegistryDeps([() => replacement])
    registry.registerProvider(stub)
    const client = createDefaultRegistryClient('/home/x', deps)
    expect(await client.providerFor(GITHUB_SOURCE)).toBe(stub)
    expect(await client.search('react')).toHaveLength(1)
  })

  it('skips a default provider whose construction fails', async () => {
    const hit = {
      name: 'b',
      source: 'skills-sh:org/b',
      popularity: 5,
      security: 'reviewed' as const,
      description: '',
    }
    const { deps, registry } = isolatedRegistryDeps([
      () => {
        throw new Error('optional provider unavailable')
      },
      () => providerDouble('skills-sh', { search: async () => [hit] }),
    ])
    const client = createDefaultRegistryClient('/home/x', deps)
    expect(await client.search('react')).toEqual([hit])
    expect(registry.listProviders().map((provider) => provider.id)).toEqual(['skills-sh'])
  })

  it('dispatches resolve / getLatestRevision / providerFor through core resolveProvider', async () => {
    const github = providerDouble()
    const { deps, registry } = isolatedRegistryDeps()
    registry.registerProvider(github)
    const client = createDefaultRegistryClient('/home/x', deps)
    expect(await client.resolve(GITHUB_SOURCE)).toEqual({
      source: GITHUB_SOURCE,
      revision: 'abc1234',
    })
    expect(await client.getLatestRevision(GITHUB_SOURCE)).toBe('def5678')
    expect(await client.providerFor(GITHUB_SOURCE)).toBe(github)
  })

  it('propagates the core SOURCE_UNSUPPORTED error for an unregistered source type', async () => {
    const { deps } = isolatedRegistryDeps()
    const client = createDefaultRegistryClient('/home/x', deps)
    await expect(client.resolve(GITHUB_SOURCE)).rejects.toMatchObject({
      code: ErrorCode.SOURCE_UNSUPPORTED,
    })
    await expect(client.getLatestRevision(GITHUB_SOURCE)).rejects.toMatchObject({
      code: ErrorCode.SOURCE_UNSUPPORTED,
    })
    await expect(client.providerFor(GITHUB_SOURCE)).rejects.toMatchObject({
      code: ErrorCode.SOURCE_UNSUPPORTED,
    })
  })

  it('wires the real core providers and registry by default', async () => {
    const client = createDefaultRegistryClient('/home/x')
    const provider: RegistryProvider = await client.providerFor({
      type: 'git',
      url: 'git@gitlab.example.com:org/repo.git',
    })
    expect(provider.id).toBe('git')
  })
})

/* ------------------------------------------------------------------ *
 * Install service
 * ------------------------------------------------------------------ */

describe('createDefaultInstallService', () => {
  const options = { repositoryRoot: '/repo', homeRoot: '/home' }

  it('maps the CLI input onto core installSkill(source, options)', async () => {
    const calls: Array<{ source: CoreNormalizedSource; options: InstallSkillOptions }> = []
    const provider = providerDouble()
    const installer = createDefaultInstallService(
      options,
      installDeps({
        installSkill: async (source, installOptions) => {
          calls.push({ source, options: installOptions })
          return coreInstallResult(source, { alias: 'foo' })
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

  it('omits the core options the CLI input leaves unset', async () => {
    let received: InstallSkillOptions | undefined
    const installer = createDefaultInstallService(
      options,
      installDeps({
        installSkill: async (source, installOptions) => {
          received = installOptions
          return coreInstallResult(source)
        },
      }),
    )
    await installer.installSkill({
      source: GITHUB_SOURCE,
      repositoryRoot: '/repo',
      allowHighRisk: false,
    })
    // `allowHighRisk: false` must not lift the security gate.
    expect(received).toEqual({ repositoryRoot: '/repo' })
  })

  it('maps the CLI input onto core updateSkill(source, options)', async () => {
    const calls: Array<{ source: CoreNormalizedSource; options: UpdateSkillOptions }> = []
    const installer = createDefaultInstallService(
      options,
      installDeps({
        updateSkill: async (source, updateOptions) => {
          calls.push({ source, options: updateOptions })
          return coreInstallResult(source, { revision: 'def5678' })
        },
      }),
    )
    await installer.updateSkill({
      name: 'foo',
      source: GITHUB_SOURCE,
      allowHighRisk: true,
      repositoryRoot: '/repo',
      homeRoot: '/home',
    })
    expect(calls[0]?.source).toEqual(GITHUB_SOURCE)
    expect(calls[0]?.options).toEqual({
      repositoryRoot: '/repo',
      alias: 'foo',
      allowPolicy: { allowHighRisk: true },
      homeRoot: '/home',
    })
  })

  it('reaches the real core transactions with the default seam', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-install-test-'))
    try {
      const installer = createDefaultInstallService(
        { repositoryRoot: base, homeRoot: base },
        installDeps(),
      )
      // `installSkill` needs a provider on the CLI input; the transaction
      // refuses before any download.
      await expect(
        installer.installSkill({ source: GITHUB_SOURCE, repositoryRoot: base }),
      ).rejects.toMatchObject({ code: ErrorCode.INSTALL_SOURCE_UNRESOLVED })
      // The update entry point is core's install *transaction*
      // `updateSkill(source, options)` — it looks the alias up in the lockfile
      // (the same-named manifest helper `updateSkill(manifest, alias, patch)`
      // could not take these arguments at all).
      await expect(
        installer.updateSkill({ name: 'foo', source: GITHUB_SOURCE, repositoryRoot: base }),
      ).rejects.toMatchObject({ code: ErrorCode.SKILL_NOT_FOUND })
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('counts cache entries with the real core clearCache and empties the cache', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cache-test-'))
    try {
      const homeRoot = path.join(base, 'home')
      // Core's home layout is what the adapter resolves against.
      const cacheRoot = buildSkillboxHomeLayout(homeRoot).cache
      // Two entries plus a transient partial staging dir (not counted).
      await fs.mkdir(path.join(cacheRoot, 'aaaa1111', 'rev-one'), { recursive: true })
      await fs.mkdir(path.join(cacheRoot, 'bbbb2222', 'rev-two'), { recursive: true })
      await fs.mkdir(path.join(cacheRoot, 'aaaa1111', '.partial-123'), { recursive: true })
      await fs.writeFile(path.join(cacheRoot, 'aaaa1111', 'rev-one', '.integrity'), 'sha256:x\n')

      const installer = createDefaultInstallService(
        { repositoryRoot: base, homeRoot },
        installDeps(),
      )
      expect(await installer.clearCache()).toEqual({ cleared: 2 })
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
        installDeps({
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

  it('falls back to the core-resolved home when the CLI home root is empty', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cache-test-'))
    try {
      const homeRoot = path.join(base, 'resolved-home')
      const cacheRoot = buildSkillboxHomeLayout(homeRoot).cache
      await fs.mkdir(path.join(cacheRoot, 'cccc3333', 'rev-three'), { recursive: true })
      const clearedCalls: string[] = []
      const installer = createDefaultInstallService(
        { repositoryRoot: base, homeRoot: '' },
        installDeps({
          resolveSkillboxHome: () => homeRoot,
          clearCache: async (clearedHome?: string) => {
            clearedCalls.push(clearedHome ?? '')
          },
        }),
      )
      expect(await installer.clearCache()).toEqual({ cleared: 1 })
      expect(clearedCalls).toEqual([homeRoot])
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ *
 * Security scanner
 * ------------------------------------------------------------------ */

describe('createDefaultSecurityScanner', () => {
  it('adapts the real core scan onto the CLI result shape', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-scan-test-'))
    try {
      await fs.mkdir(path.join(base, 'scripts'))
      await fs.writeFile(path.join(base, 'SKILL.md'), '# hello\n')
      await fs.writeFile(
        path.join(base, 'scripts', 'run.sh'),
        '#!/bin/sh\nchild_process.exec("rm -rf /tmp/x")\n',
      )
      const result = await createDefaultSecurityScanner().scan(base)
      expect(result.risk).toBe('high')
      expect(result.block).toBe(true)
      expect(result.filesScanned).toBe(2)
      const shell = result.findings.find((finding) => finding.pattern === 'shell-exec')
      expect(shell).toMatchObject({
        file: 'scripts/run.sh',
        line: 2,
        risk: 'high',
        recommendation: expect.any(String),
      })
      expect(shell?.recommendation.length).toBeGreaterThan(0)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('delegates to the injected scanner and returns its result unchanged', async () => {
    const scanned: string[] = []
    const review: CoreSecurityScanResult = {
      risk: 'low',
      findings: [
        {
          pattern: 'shell-script-file',
          name: 'Shell script file',
          risk: 'low',
          file: 'setup.sh',
          recommendation: 'Review the script before running it.',
        },
      ],
      filesScanned: 3,
      block: false,
    }
    const deps: MarketplaceSecurityScannerDeps = {
      scanSkillForSecurity: async (skillRoot: string) => {
        scanned.push(skillRoot)
        return review
      },
    }
    expect(await createDefaultSecurityScanner(deps).scan('/tmp/skill')).toEqual(review)
    expect(scanned).toEqual(['/tmp/skill'])
  })
})
