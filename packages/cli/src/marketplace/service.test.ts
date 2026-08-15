import { describe, expect, it } from 'vitest'
import { ErrorCode, SkillboxError, type AgentRegistry } from '@skillbox/core'
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
import { MarketplaceService, normalizeLockedSource } from './service.js'
import type { NormalizedSource } from './types.js'

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
