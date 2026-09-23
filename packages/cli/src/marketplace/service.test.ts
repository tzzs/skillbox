import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AgentRegistry,
  buildSkillboxHomeLayout,
  computeSkillIntegrity,
  ErrorCode,
  installSkill as runCoreInstallTransaction,
  ManagedCache,
  SkillboxError,
  type InstallResult,
  type RegistrySearchResult,
  type ResolvedSource,
} from '@skillbox/core'
import {
  agentRegistry,
  CANCEL,
  createFixture,
  FakeInstaller,
  FakePrompts,
  FakeRegistryClient,
  FakeScanner,
  FakeSourceParser,
} from './test-support.js'
import { createDefaultInstallService, defaultMarketplaceInstallServiceDeps } from './loaders.js'
import { MarketplaceService, normalizeLockedSource } from './service.js'
import type { NormalizedSource, RegistryClient, RegistryProvider } from './types.js'

const GITHUB_SOURCE: NormalizedSource = {
  type: 'github',
  repo: 'vercel-labs/agent-skills',
  path: 'skills/react-best-practices',
}

const HIGH_RISK_REVIEW = {
  risk: 'high' as const,
  block: true,
  filesScanned: 2,
  findings: [
    {
      pattern: 'shell-exec',
      name: 'Shell command execution',
      risk: 'high' as const,
      file: 'build.sh',
      line: 1,
      recommendation: 'Review',
    },
  ],
}

interface Harness {
  service: MarketplaceService
  prompts: FakePrompts
  installer: FakeInstaller
  registryClient: FakeRegistryClient
  scanner: FakeScanner
  parser: FakeSourceParser
  fixture: ReturnType<typeof createFixture>
  /** Captured non-interactive output (evaluated lazily). */
  out(): string
}

function createHarness(
  overrides: {
    parser?: FakeSourceParser
    registry?: AgentRegistry
    detected?: readonly string[]
    isInteractive?: boolean
    prompts?: FakePrompts
  } = {},
): Harness {
  const fixture = createFixture()
  const prompts = overrides.prompts ?? new FakePrompts()
  const installer = new FakeInstaller()
  const registryClient = new FakeRegistryClient()
  const scanner = new FakeScanner()
  const parser = overrides.parser ?? new FakeSourceParser(GITHUB_SOURCE)
  const captured = { text: '' }
  const service = new MarketplaceService({
    repositoryRoot: fixture.repositoryRoot,
    homeRoot: fixture.homeRoot,
    registry: overrides.registry ?? agentRegistry(['claude', 'codex'], overrides.detected ?? []),
    sourceParser: parser,
    registryClient,
    installer,
    scanner,
    prompts,
    isInteractive: overrides.isInteractive ?? false,
    out: (chunk) => {
      captured.text += chunk
    },
  })
  return {
    service,
    prompts,
    installer,
    registryClient,
    scanner,
    parser,
    fixture,
    out: () => captured.text,
  }
}

describe('MarketplaceService.search', () => {
  it('aggregates provider hits, dedupes by source and sorts by popularity', async () => {
    const { service, registryClient } = createHarness()
    registryClient.searchResults = [
      { name: 'a', source: 'github:x/a', popularity: 10, security: 'reviewed', description: '' },
      { name: 'b', source: 'skills-sh:x/b', popularity: 500, security: 'unknown', description: '' },
      {
        name: 'a-copy',
        source: 'github:x/a',
        popularity: 20,
        security: 'unknown',
        description: '',
      },
    ]
    const results = await service.search('react')
    expect(results.map((r) => r.name)).toEqual(['b', 'a-copy'])
  })

  it('passes the query through to the registry client', async () => {
    const calls: string[] = []
    const svc = new MarketplaceService({
      repositoryRoot: '',
      homeRoot: '',
      registry: agentRegistry([]),
      sourceParser: new FakeSourceParser(GITHUB_SOURCE),
      registryClient: {
        search: async (q) => {
          calls.push(q)
          return []
        },
        resolve: async () => {
          throw new Error('n/a')
        },
        getLatestRevision: async () => {
          throw new Error('n/a')
        },
        providerFor: async () => {
          throw new Error('n/a')
        },
      },
      installer: new FakeInstaller(),
      scanner: new FakeScanner(),
      prompts: new FakePrompts(),
      isInteractive: false,
      out: () => undefined,
    })
    await svc.search('react')
    expect(calls).toEqual(['react'])
  })

  it('returns [] when no provider answers', async () => {
    const { service } = createHarness()
    expect(await service.search('')).toEqual([])
  })
})

describe('MarketplaceService.add', () => {
  it('runs parse → resolve → review → install and returns the outcome', async () => {
    const { service, installer, scanner, out } = createHarness({ detected: ['claude'] })
    const outcome = await service.add({ source: 'vercel-labs/agent-skills@react-best-practices' })
    expect(outcome).toMatchObject({
      source: 'vercel-labs/agent-skills@react-best-practices',
      alias: 'react-best-practices',
      revision: 'abc1234def5678',
      integrity: 'sha256:test-integrity',
      agents: ['claude'],
      manifestChanged: true,
      lockfileChanged: true,
    })
    expect(installer.installCalls).toHaveLength(1)
    const call = installer.installCalls[0]
    expect(call?.source).toEqual(GITHUB_SOURCE)
    expect(call?.targetAgents).toEqual(['claude'])
    expect(call?.allowHighRisk).toBe(false) // low risk: no high-risk override
    expect(call?.provider).toBeDefined()
    expect(call?.repositoryRoot).toBeDefined()
    expect(scanner.scanCalls).toHaveLength(1)
    expect(out()).toContain('Resolving')
    expect(out()).toContain('Scanning')
  })

  it('honours --name (alias) and --agent flags', async () => {
    const { service, installer } = createHarness()
    const outcome = await service.add({
      source: 'github:x/y',
      alias: 'custom-alias',
      agent: 'codex',
    })
    expect(outcome.alias).toBe('custom-alias')
    expect(installer.installCalls[0]?.alias).toBe('custom-alias')
    expect(installer.installCalls[0]?.targetAgents).toEqual(['codex'])
  })

  it('rejects an unknown --agent with AGENT_NOT_FOUND', async () => {
    const { service } = createHarness()
    await expect(service.add({ source: 'x', agent: 'bogus' })).rejects.toMatchObject({
      code: ErrorCode.AGENT_NOT_FOUND,
    })
  })

  it('fails with AGENT_NOT_DETECTED when no agents exist at all', async () => {
    const { service } = createHarness({ registry: agentRegistry([]) })
    await expect(service.add({ source: 'x' })).rejects.toMatchObject({
      code: ErrorCode.AGENT_NOT_DETECTED,
    })
  })

  it('auto-picks the single detected agent non-interactively', async () => {
    const { service, installer, out } = createHarness({ detected: ['claude'] })
    await service.add({ source: 'x' })
    expect(installer.installCalls[0]?.targetAgents).toEqual(['claude'])
    expect(out()).toContain('Installing for agent "claude"')
  })

  it('fails with AGENT_LINK_CONFLICT when multiple agents need a picker but none is interactive', async () => {
    const { service } = createHarness({ detected: ['claude', 'codex'] })
    await expect(service.add({ source: 'x' })).rejects.toMatchObject({
      code: ErrorCode.AGENT_LINK_CONFLICT,
    })
  })

  it('offers the detected agents through the interactive picker and cancels cleanly', async () => {
    const prompts = new FakePrompts()
    prompts.selectResult = CANCEL
    const { service, prompts: p } = createHarness({
      detected: ['claude', 'codex'],
      isInteractive: true,
      prompts,
    })
    const outcome = await service.add({ source: 'x' })
    expect(outcome.cancelled).toBe(true)
    expect(p.calls).toContain('select:claude,codex')
    expect(outcome.alias).toBeUndefined()
  })

  it('uses the picker result as the install target interactively', async () => {
    const { service, installer } = createHarness({
      detected: ['claude', 'codex'],
      isInteractive: true,
    })
    const outcome = await service.add({ source: 'x' })
    expect(installer.installCalls[0]?.targetAgents).toEqual(['claude'])
    expect(outcome.agents).toEqual(['claude'])
  })

  it('shows the security review and proceeds for low risk', async () => {
    const prompts = new FakePrompts()
    const { service, prompts: p, out } = createHarness({ isInteractive: true, prompts })
    await service.add({ source: 'x' })
    expect(p.calls).toContain('note:Security Review')
    expect(out()).toBe('')
  })

  it('blocks HIGH-risk installs without --yes in non-interactive mode', async () => {
    const { service, installer, scanner } = createHarness({ detected: ['claude'] })
    scanner.review = HIGH_RISK_REVIEW
    await expect(service.add({ source: 'x' })).rejects.toMatchObject({
      code: ErrorCode.INSTALL_SECURITY_BLOCKED,
    })
    // The gate runs before the transaction: nothing was installed.
    expect(installer.installCalls).toHaveLength(0)
    expect(scanner.scanCalls).toHaveLength(1)
  })

  it('proceeds on HIGH risk with --yes', async () => {
    const { service, installer, scanner, out } = createHarness({ detected: ['claude'] })
    scanner.review = HIGH_RISK_REVIEW
    const outcome = await service.add({ source: 'x', yes: true })
    expect(outcome.alias).toBeDefined()
    expect(installer.installCalls[0]?.allowHighRisk).toBe(true)
    expect(out()).toContain('Installing a HIGH-risk skill anyway')
  })

  it('asks interactively for HIGH risk and honours a decline', async () => {
    const prompts = new FakePrompts()
    prompts.confirmResult = false
    const {
      service,
      installer,
      scanner,
      prompts: p,
    } = createHarness({
      detected: ['claude'],
      isInteractive: true,
      prompts,
    })
    scanner.review = HIGH_RISK_REVIEW
    await expect(service.add({ source: 'x' })).rejects.toMatchObject({
      code: ErrorCode.INSTALL_SECURITY_BLOCKED,
    })
    expect(p.calls.some((call) => call.startsWith('confirm:'))).toBe(true)
    expect(installer.installCalls).toHaveLength(0)
  })

  it('surfaces parse failures as SOURCE_INVALID', async () => {
    const { service } = createHarness({
      parser: new FakeSourceParser(undefined, new Error('boom')),
    })
    await expect(service.add({ source: ':::' })).rejects.toMatchObject({
      code: ErrorCode.SOURCE_INVALID,
    })
  })

  it('wraps resolve failures in a typed error', async () => {
    const { service, registryClient } = createHarness()
    registryClient.resolveError = new Error('network down')
    await expect(service.add({ source: 'x' })).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
  })

  it('wraps provider/download failures during the review as REGISTRY_UNAVAILABLE', async () => {
    const { service, scanner } = createHarness()
    scanner.scanError = new Error('scan backend down')
    await expect(service.add({ source: 'x' })).rejects.toMatchObject({
      code: ErrorCode.REGISTRY_UNAVAILABLE,
    })
  })

  it('wraps unknown install failures but passes SkillboxErrors through', async () => {
    const { service, installer } = createHarness({ detected: ['claude'] })
    installer.installError = new Error('disk full')
    await expect(service.add({ source: 'x' })).rejects.toMatchObject({
      code: ErrorCode.INSTALL_DOWNLOAD_FAILED,
    })

    installer.installError = new SkillboxError(ErrorCode.INSTALL_CONFLICT, 'already installed')
    await expect(service.add({ source: 'x' })).rejects.toMatchObject({
      code: ErrorCode.INSTALL_CONFLICT,
    })
  })
})

/* ------------------------------------------------------------------ *
 * Managed-cache warm-up — one download per `skillbox add` run
 * ------------------------------------------------------------------ */

const REVIEW_REVISION = 'abc1234def5678'
/** Benign content: the transaction's own (real) security scan must accept it. */
const SKILL_MD = `---
name: react-best-practices
description: Function components and hooks.
---

# React Best Practices

Prefer function components. Keep components small.
`

/** Provider fake that really writes the revision's bytes and counts round trips. */
class CountingProvider implements RegistryProvider {
  id = 'github'
  downloads: { revision: string; targetDir: string }[] = []

  async search(): Promise<RegistrySearchResult[]> {
    return []
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    return { source, revision: REVIEW_REVISION }
  }

  async download(_source: NormalizedSource, revision: string, targetDir: string): Promise<void> {
    this.downloads.push({ revision, targetDir })
    await fsp.writeFile(path.join(targetDir, 'SKILL.md'), SKILL_MD)
  }

  async getLatestRevision(): Promise<string> {
    return REVIEW_REVISION
  }
}

/**
 * Agent registry with a temp skills dir: the real transaction's link step needs
 * a reachable directory, and it must never be a developer's agent home.
 */
function agentRegistryWithSkillsDir(skillsDir: string): AgentRegistry {
  const registry = new AgentRegistry()
  registry.register({
    id: 'claude',
    name: 'claude',
    capabilities: {
      supportsGlobalSkills: true,
      supportsProjectSkills: false,
      supportsSymlinks: true,
      supportsNestedSkillDirectories: false,
      requiresRestartAfterChange: false,
    },
    detect: async () => ({ detected: true, confidence: 'high', skillDirectories: [skillsDir] }),
    getSkillDirectories: async () => [skillsDir],
    scanSkills: async () => [],
    linkSkill: async () => undefined,
    unlinkSkill: async () => ({ name: 'claude', path: '', removed: false, reason: 'not_found' }),
  })
  return registry
}

interface WarmHarness {
  service: MarketplaceService
  provider: CountingProvider
  scanner: FakeScanner
  cache: ManagedCache
  fixture: ReturnType<typeof createFixture>
  /** Results of the real core transactions the `add` ran (usually 0 or 1). */
  installs: InstallResult[]
}

/**
 * The `add` flow over the REAL core install transaction (and therefore the real
 * managed cache), with only two seams faked: the registry provider (to count
 * downloads) and the agent directory (to stay inside the fixture).
 */
async function createWarmCacheHarness(): Promise<WarmHarness> {
  const fixture = createFixture()
  const skillsDir = path.join(fixture.base, 'agent-skills')
  await fsp.mkdir(skillsDir, { recursive: true })
  const provider = new CountingProvider()
  const registry = agentRegistryWithSkillsDir(skillsDir)
  const installs: InstallResult[] = []
  const installer = createDefaultInstallService(
    { repositoryRoot: fixture.repositoryRoot, homeRoot: fixture.homeRoot },
    {
      ...defaultMarketplaceInstallServiceDeps,
      // No process-wide provider registration: the harness injects its provider.
      listProviders: () => [],
      registerProvider: () => undefined,
      providerFactories: [],
      installSkill: async (source, options) => {
        const result = await runCoreInstallTransaction(source, {
          ...options,
          agentRegistry: registry,
        })
        installs.push(result)
        return result
      },
    },
  )
  const registryClient: RegistryClient = {
    search: async () => [],
    resolve: async (source) => ({ source, revision: REVIEW_REVISION }),
    getLatestRevision: async () => REVIEW_REVISION,
    providerFor: async () => provider,
  }
  const scanner = new FakeScanner()
  const service = new MarketplaceService({
    repositoryRoot: fixture.repositoryRoot,
    homeRoot: fixture.homeRoot,
    registry,
    sourceParser: new FakeSourceParser(GITHUB_SOURCE),
    registryClient,
    installer,
    scanner,
    prompts: new FakePrompts(),
    isInteractive: false,
    out: () => undefined,
  })
  return {
    service,
    provider,
    scanner,
    cache: new ManagedCache(buildSkillboxHomeLayout(fixture.homeRoot).cache),
    fixture,
    installs,
  }
}

/**
 * True once the review's temp root (parent of the dir the provider downloaded
 * into) is gone — publishing to the cache must not leave the copy behind.
 */
async function stagingRemoved(downloadDir: string | undefined): Promise<boolean> {
  if (downloadDir === undefined) {
    return false
  }
  try {
    await fsp.stat(path.dirname(downloadDir))
    return false
  } catch {
    return true
  }
}

describe('MarketplaceService.add managed-cache warm-up', () => {
  it('downloads the reviewed revision once and installs it from the cache', async () => {
    const harness = await createWarmCacheHarness()
    try {
      // Integrity the plain two-download flow records: the canonical hash of the
      // downloaded bytes, independent of which directory they were hashed in.
      const seed = path.join(harness.fixture.base, 'upstream')
      await fsp.mkdir(seed, { recursive: true })
      await fsp.writeFile(path.join(seed, 'SKILL.md'), SKILL_MD)
      const expectedIntegrity = await computeSkillIntegrity(seed)

      const outcome = await harness.service.add({ source: 'vercel-labs/agent-skills@react' })

      // One network round trip for the whole run instead of two.
      expect(harness.provider.downloads).toHaveLength(1)
      const install = harness.installs[0]
      expect(install?.cacheHit).toBe(true)
      expect(install?.revision).toBe(REVIEW_REVISION)
      expect(install?.integrity).toBe(expectedIntegrity)
      expect(outcome.revision).toBe(REVIEW_REVISION)
      expect(outcome.integrity).toBe(expectedIntegrity)
      expect(outcome.agents).toEqual(['claude'])

      // What the install materialized is still the reviewed content — served now
      // from the cache entry instead of a second download.
      expect(
        await fsp.readFile(path.join(install?.materializedPath ?? '', 'SKILL.md'), 'utf8'),
      ).toBe(SKILL_MD)

      // The entry the install read holds exactly the scanned bytes, under the
      // (source, revision) pair, with a marker that agrees with its content.
      const entry = await harness.cache.get(GITHUB_SOURCE, REVIEW_REVISION)
      expect(entry).not.toBeNull()
      expect(entry?.integrity).toBe(expectedIntegrity)
      expect(await fsp.readFile(path.join(entry?.path ?? '', 'SKILL.md'), 'utf8')).toBe(SKILL_MD)

      // Same install result as before: the lockfile pins revision + integrity.
      const lockfile = await fsp.readFile(
        path.join(harness.fixture.repositoryRoot, 'skillbox.lock'),
        'utf8',
      )
      expect(lockfile).toContain(REVIEW_REVISION)
      expect(lockfile).toContain(expectedIntegrity)

      // The staged download is discarded once the cache has it: no temp leak.
      expect(await stagingRemoved(harness.provider.downloads[0]?.targetDir)).toBe(true)
    } finally {
      harness.fixture.cleanup()
    }
  })

  it('keeps a blocked review out of the cache', async () => {
    const harness = await createWarmCacheHarness()
    try {
      harness.scanner.review = HIGH_RISK_REVIEW
      await expect(harness.service.add({ source: 'x' })).rejects.toMatchObject({
        code: ErrorCode.INSTALL_SECURITY_BLOCKED,
      })
      // Nothing installed, nothing cached: the next run re-downloads and re-scans.
      expect(harness.installs).toHaveLength(0)
      expect(await harness.cache.get(GITHUB_SOURCE, REVIEW_REVISION)).toBeNull()
      expect(await fsp.readdir(harness.cache.cacheRoot).catch(() => [])).toEqual([])
      // The download the review rejected is gone, not parked somewhere.
      expect(await stagingRemoved(harness.provider.downloads[0]?.targetDir)).toBe(true)
    } finally {
      harness.fixture.cleanup()
    }
  })

  it('caches nothing when the review itself fails', async () => {
    const harness = await createWarmCacheHarness()
    try {
      harness.scanner.scanError = new Error('scan backend down')
      await expect(harness.service.add({ source: 'x' })).rejects.toMatchObject({
        code: ErrorCode.REGISTRY_UNAVAILABLE,
      })
      expect(await harness.cache.get(GITHUB_SOURCE, REVIEW_REVISION)).toBeNull()
      expect(await stagingRemoved(harness.provider.downloads[0]?.targetDir)).toBe(true)
    } finally {
      harness.fixture.cleanup()
    }
  })

  it('leaves a HIGH-risk override to the transaction instead of pre-warming', async () => {
    const harness = await createWarmCacheHarness()
    try {
      harness.scanner.review = HIGH_RISK_REVIEW
      const outcome = await harness.service.add({ source: 'x', yes: true })
      // Deliberate cost of the rule above: a review that blocked still downloads
      // twice, because only the transaction may decide what HIGH risk is worth
      // caching — exactly the ordering `transaction.ts` step 6 uses.
      expect(harness.provider.downloads).toHaveLength(2)
      expect(harness.installs[0]?.cacheHit).toBe(false)
      expect(outcome.alias).toBe('react-best-practices')
      expect(await harness.cache.get(GITHUB_SOURCE, REVIEW_REVISION)).not.toBeNull()
    } finally {
      harness.fixture.cleanup()
    }
  })

  it('serves a revision that is already cached without downloading at all', async () => {
    const harness = await createWarmCacheHarness()
    try {
      const seed = path.join(harness.fixture.base, 'upstream')
      await fsp.mkdir(seed, { recursive: true })
      await fsp.writeFile(path.join(seed, 'SKILL.md'), SKILL_MD)
      await harness.cache.put(
        GITHUB_SOURCE,
        REVIEW_REVISION,
        await computeSkillIntegrity(seed),
        seed,
      )

      const outcome = await harness.service.add({ source: 'x' })

      expect(harness.provider.downloads).toHaveLength(0)
      expect(harness.installs[0]?.cacheHit).toBe(true)
      expect(outcome.integrity).toBe(await computeSkillIntegrity(seed))
    } finally {
      harness.fixture.cleanup()
    }
  })
})

describe('MarketplaceService.outdated', () => {
  it('returns [] without a lockfile', async () => {
    const { service } = createHarness()
    expect(await service.outdated()).toEqual([])
  })

  it('compares locked revisions against the latest upstream (M16.1)', async () => {
    const { service, fixture, registryClient } = createHarness()
    fixture.writeLockfile(
      `lockfileVersion: 1
skills:
  foo:
    mode: managed
    source:
      type: github
      repo: org/foo
    revision: aaaaaaa
    integrity: h1
  bar:
    mode: managed
    source:
      type: github
      repo: org/bar
    revision: bbbbbbb
    integrity: h2
  baz:
    mode: managed
    source:
      type: github
      repo: org/baz
    revision: ccccccc
    integrity: h3
`,
    )
    registryClient.latestByRepo.set('org/foo', 'aaaaaaa') // up-to-date
    registryClient.latestByRepo.set('org/bar', 'bbbbbbb2') // outdated
    // org/baz: getLatestRevision throws → unknown
    const entries = await service.outdated()
    expect(entries).toEqual([
      { name: 'foo', installed: 'aaaaaaa', latest: 'aaaaaaa', status: 'up-to-date' },
      { name: 'bar', installed: 'bbbbbbb', latest: 'bbbbbbb2', status: 'outdated' },
      { name: 'baz', installed: 'ccccccc', status: 'unknown' },
    ])
  })

  it('skips non-managed skills and flags unsupported sources', async () => {
    const { service, fixture } = createHarness()
    fixture.writeLockfile(`lockfileVersion: 1
skills:
  managed-foo:
    mode: managed
    source:
      type: registry
      registry: other
      package: x/y
    revision: aaaaaaa
    integrity: h1
  local-skill:
    mode: local
    source:
      type: local
      path: skills/local-skill
    integrity: h2
`)
    const entries = await service.outdated()
    expect(entries).toEqual([{ name: 'managed-foo', installed: 'aaaaaaa', status: 'unsupported' }])
  })
})

describe('MarketplaceService.update', () => {
  it('re-reads the lockfile revision after the update (M16.2)', async () => {
    const { service, fixture, installer } = createHarness()
    fixture.writeLockfile(
      `lockfileVersion: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
    revision: aaaaaaa
    integrity: h1
`,
    )
    fixture.writeManifest(
      `version: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
    agents:
      - claude
`,
    )
    installer.afterUpdate = async () => {
      fixture.writeLockfile(
        `lockfileVersion: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
    revision: bbbbbbb
    integrity: h2
`,
      )
    }
    const outcome = await service.update({ name: 'react-best-practices' })
    expect(outcome).toMatchObject({
      name: 'react-best-practices',
      fromRevision: 'aaaaaaa',
      toRevision: 'bbbbbbb',
      lockfileChanged: true,
      linkedAgents: ['claude'],
    })
    expect(installer.updateCalls[0]?.source).toEqual({
      type: 'github',
      repo: 'vercel-labs/agent-skills',
      path: 'skills/react-best-practices',
    })
    expect(installer.updateCalls[0]?.name).toBe('react-best-practices')
    expect(installer.updateCalls[0]?.allowHighRisk).toBe(false)
  })

  it('fails with SKILL_NOT_FOUND for an unknown name', async () => {
    const { service, fixture } = createHarness()
    fixture.writeLockfile('lockfileVersion: 1\nskills: {}\n')
    await expect(service.update({ name: 'ghost' })).rejects.toMatchObject({
      code: ErrorCode.SKILL_NOT_FOUND,
    })
  })

  it('fails with LOCKFILE_NOT_FOUND without a lockfile', async () => {
    const { service } = createHarness()
    await expect(service.update({ name: 'ghost' })).rejects.toMatchObject({
      code: ErrorCode.LOCKFILE_NOT_FOUND,
    })
  })

  it('refuses non-managed skills (SOURCE_UNSUPPORTED)', async () => {
    const { service, fixture } = createHarness()
    fixture.writeLockfile(
      `lockfileVersion: 1
skills:
  local-skill:
    mode: local
    source:
      type: local
      path: skills/local-skill
    integrity: h1
`,
    )
    await expect(service.update({ name: 'local-skill' })).rejects.toMatchObject({
      code: ErrorCode.SOURCE_UNSUPPORTED,
    })
  })

  it('passes the security gate through to the update transaction', async () => {
    const { service, fixture, installer } = createHarness()
    fixture.writeLockfile(
      `lockfileVersion: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
    revision: aaaaaaa
    integrity: h1
`,
    )
    installer.updateError = new SkillboxError(
      ErrorCode.INSTALL_SECURITY_BLOCKED,
      'Security scan rated the updated skill "high" risk',
    )
    await expect(service.update({ name: 'react-best-practices' })).rejects.toMatchObject({
      code: ErrorCode.INSTALL_SECURITY_BLOCKED,
    })
  })

  it('passes --yes through as the high-risk override', async () => {
    const { service, fixture, installer } = createHarness()
    fixture.writeLockfile(
      `lockfileVersion: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
    revision: aaaaaaa
    integrity: h1
`,
    )
    await service.update({ name: 'react-best-practices', yes: true })
    expect(installer.updateCalls[0]?.allowHighRisk).toBe(true)
  })
})

describe('MarketplaceService.cacheClean', () => {
  it('reports the number of entries freed', async () => {
    const { service, installer } = createHarness()
    const outcome = await service.cacheClean()
    expect(outcome.cleared).toBe(3)
    expect(installer.clearCacheCalls).toBe(1)
  })
})

describe('normalizeLockedSource', () => {
  it('maps github manifest sources onto the registry framework', () => {
    expect(normalizeLockedSource({ type: 'github', repo: 'org/repo', path: 'skills/x' })).toEqual({
      type: 'github',
      repo: 'org/repo',
      path: 'skills/x',
    })
    expect(normalizeLockedSource({ type: 'local', path: 'skills/x' })).toEqual({
      type: 'local',
      path: 'skills/x',
    })
  })

  it('maps git manifest sources onto the registry framework', () => {
    expect(
      normalizeLockedSource({
        type: 'git',
        url: 'https://git.example.com/org/repo.git',
        path: 'skills/hello',
        ref: 'main',
      }),
    ).toEqual({
      type: 'git',
      url: 'https://git.example.com/org/repo.git',
      path: 'skills/hello',
      ref: 'main',
    })
  })

  it('returns undefined for sources the framework cannot represent yet', () => {
    expect(
      normalizeLockedSource({ type: 'registry', registry: 'skills.sh', package: 'org/x' }),
    ).toEqual({ type: 'skills-sh', package: 'org/x' })
    expect(
      normalizeLockedSource({ type: 'registry', registry: 'other', package: 'org/x' }),
    ).toBeUndefined()
  })
})
