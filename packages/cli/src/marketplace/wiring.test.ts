import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCode, SkillboxError } from '@skillbox/core'
import { main, type CliDeps } from '../index.js'
import {
  agentRegistry,
  CANCEL,
  createFixture,
  FakeInstaller,
  FakePrompts,
  FakeRegistryClient,
  FakeScanner,
  FakeSourceParser,
  type Fixture,
} from './test-support.js'
import type { NormalizedSource } from './types.js'

/**
 * End-to-end wiring: the five marketplace commands registered in program.ts,
 * exercised through the real `main()` entry with fake providers injected via
 * CliDeps.marketplace.
 */

const GITHUB_SOURCE: NormalizedSource = {
  type: 'github',
  repo: 'vercel-labs/agent-skills',
  path: 'skills/react-best-practices',
}

const HIGH_RISK_REVIEW = {
  risk: 'high' as const,
  block: true,
  filesScanned: 1,
  findings: [],
}

interface Io {
  out(): string
  err(): string
}

function capture(): CliDeps & Io {
  const chunks: string[] = []
  const errorChunks: string[] = []
  return {
    stdout: (chunk: string) => chunks.push(chunk),
    stderr: (chunk: string) => errorChunks.push(chunk),
    out: () => chunks.join(''),
    err: () => errorChunks.join(''),
  }
}

interface Wiring {
  io: CliDeps & Io
  fixture: Fixture
  installer: FakeInstaller
  registryClient: FakeRegistryClient
  scanner: FakeScanner
  prompts: FakePrompts
  deps(): CliDeps
}

function createWiring(
  overrides: { detected?: readonly string[]; isInteractive?: boolean } = {},
): Wiring {
  const io = capture()
  const fixture = createFixture()
  const installer = new FakeInstaller()
  const registryClient = new FakeRegistryClient()
  const scanner = new FakeScanner()
  const prompts = new FakePrompts()
  const deps: CliDeps = {
    ...io,
    repositoryRoot: fixture.repositoryRoot,
    homeRoot: fixture.homeRoot,
    registry: agentRegistry(['claude', 'codex'], overrides.detected ?? []),
    prompts,
    isInteractive: overrides.isInteractive ?? false,
    marketplace: {
      sourceParser: new FakeSourceParser(GITHUB_SOURCE),
      registryClient,
      installer,
      scanner,
    },
  }
  return { io, fixture, installer, registryClient, scanner, prompts, deps: () => deps }
}

describe('skillbox search', () => {
  it('prints a table of aggregated results sorted by popularity', async () => {
    const wiring = createWiring()
    wiring.registryClient.searchResults = [
      {
        name: 'react-a',
        source: 'github:org/react-a',
        popularity: 10,
        security: 'reviewed',
        description: '',
      },
      {
        name: 'react-b',
        source: 'skills-sh:org/react-b',
        popularity: 99,
        security: 'unknown',
        description: '',
      },
    ]
    const exit = await main(['search', 'react'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('NAME')
    expect(out).toContain('SOURCE')
    expect(out).toContain('POPULARITY')
    expect(out).toContain('SECURITY')
    // popularity-sorted: react-b (99) first
    expect(out.indexOf('react-b')).toBeLessThan(out.indexOf('react-a'))
  })

  it('emits JSON with --json', async () => {
    const wiring = createWiring()
    wiring.registryClient.searchResults = [
      {
        name: 'react-a',
        source: 'github:org/react-a',
        popularity: 1,
        security: 'unknown',
        description: '',
      },
    ]
    const exit = await main(['search', 'react', '--json'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('"results"')
    expect(wiring.io.out()).toContain('"name": "react-a"')
  })

  it('shows a usage hint when the query matches nothing', async () => {
    const wiring = createWiring()
    const exit = await main(['search', 'zzz-not-here'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('no skills found')
    expect(wiring.io.out()).toContain('Usage: skillbox search <query>')
  })

  it('accepts an empty query for the popular list', async () => {
    const wiring = createWiring()
    const exit = await main(['search'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('no skills found')
  })
})

describe('skillbox add', () => {
  it('installs for a single detected agent with a summary', async () => {
    const wiring = createWiring({ detected: ['claude'] })
    const exit = await main(['add', 'vercel-labs/agent-skills@react-best-practices'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('Added "react-best-practices"')
    expect(out).toContain('Installing for agent "claude"')
    expect(out).toContain('manifest   updated')
    expect(out).toContain('lockfile   updated')
    expect(wiring.installer.installCalls).toHaveLength(1)
    expect(wiring.scanner.scanCalls).toHaveLength(1)
  })

  it('supports --agent and --yes for non-interactive installs', async () => {
    const wiring = createWiring()
    wiring.scanner.review = HIGH_RISK_REVIEW
    const exit = await main(
      ['add', 'vercel-labs/agent-skills@react-best-practices', '--agent', 'codex', '--yes'],
      wiring.deps(),
    )
    expect(exit).toBe(0)
    expect(wiring.installer.installCalls[0]?.targetAgents).toEqual(['codex'])
    expect(wiring.installer.installCalls[0]?.allowHighRisk).toBe(true)
    expect(wiring.io.out()).toContain('Installing a HIGH-risk skill anyway')
  })

  it('blocks a HIGH-risk install without --yes (exit code 4)', async () => {
    const wiring = createWiring({ detected: ['claude'] })
    wiring.scanner.review = HIGH_RISK_REVIEW
    const exit = await main(['add', 'github:x/y'], wiring.deps())
    expect(exit).toBe(4)
    expect(wiring.io.err()).toContain('HIGH security risk')
    expect(wiring.io.err()).toContain('--yes')
    expect(wiring.installer.installCalls).toHaveLength(0)
  })

  it('reports a cancelled interactive picker as a clean exit', async () => {
    const wiring = createWiring({ detected: ['claude', 'codex'], isInteractive: true })
    wiring.prompts.selectResult = CANCEL
    const exit = await main(['add', 'github:x/y'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('Install cancelled.')
    expect(wiring.installer.installCalls).toHaveLength(0)
  })

  it('surfaces parse failures with exit code 2 (validation)', async () => {
    const wiring = createWiring()
    wiring.deps().marketplace = {
      sourceParser: new FakeSourceParser(undefined, new Error('bad format')),
    }
    const exit = await main(['add', '::not-a-source::'], wiring.deps())
    expect(exit).toBe(2)
    expect(wiring.io.err()).toContain('Cannot parse source')
  })

  it('surfaces unknown agents with exit code 1', async () => {
    const wiring = createWiring()
    const exit = await main(['add', 'github:x/y', '--agent', 'bogus'], wiring.deps())
    expect(exit).toBe(1)
    expect(wiring.io.err()).toContain('Unknown agent "bogus"')
  })

  it('falls back to the default loaders without marketplace wiring (typed error, no crash)', async () => {
    // No `marketplace` overrides → program.ts builds the default adapters over
    // the real `@skillbox/core` exports. An invalid source fails in the core
    // parser with a typed validation error instead of crashing.
    const io = capture()
    const exit = await main(['add', '::not-a-source::'], {
      ...io,
      repositoryRoot: process.cwd(),
      homeRoot: process.cwd(),
      isInteractive: false,
    })
    expect(exit).toBe(2)
    expect(io.err()).toContain('Invalid skill source')
  })
})

describe('skillbox outdated', () => {
  it('prints NAME / INSTALLED / LATEST / STATUS', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile(
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
`,
    )
    wiring.registryClient.latestByRepo.set('org/foo', 'aaaaaaa')
    wiring.registryClient.latestByRepo.set('org/bar', 'ccccccc')
    const exit = await main(['outdated'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('INSTALLED')
    expect(out).toContain('LATEST')
    expect(out).toContain('foo')
    expect(out).toContain('up-to-date')
    expect(out).toContain('bar')
    expect(out).toContain('outdated')
  })

  it('emits JSON with --json', async () => {
    const wiring = createWiring()
    const exit = await main(['outdated', '--json'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('"entries"')
  })

  it('says there is nothing to compare without a lockfile', async () => {
    const wiring = createWiring()
    const exit = await main(['outdated'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('(no managed skills found)')
  })
})

describe('skillbox update', () => {
  it('prints the before/after revision and preserved links', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile(
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
    wiring.fixture.writeManifest(
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
    wiring.installer.afterUpdate = async () => {
      wiring.fixture.writeLockfile(
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
    const exit = await main(['update', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('Updated "react-best-practices": aaaaaaa → bbbbbbb')
    expect(out).toContain('claude (links preserved)')
    expect(out).toContain('lockfile   updated')
  })

  it('rejects non-managed skills (exit 2)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile(
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
    const exit = await main(['update', 'local-skill'], wiring.deps())
    expect(exit).toBe(2)
    expect(wiring.io.err()).toContain('only managed')
  })

  it('reports a missing skill (exit 1)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile('lockfileVersion: 1\nskills: {}\n')
    const exit = await main(['update', 'ghost'], wiring.deps())
    expect(exit).toBe(1)
    expect(wiring.io.err()).toContain('is not installed')
  })

  it('runs the real update transaction without prewarming the default registry', async () => {
    // No marketplace overrides and no preceding registry-client call: the
    // installer adapter must make the first-party providers available itself.
    const io = capture()
    const fixture = createFixture()
    try {
      const localSkill = path.join(fixture.base, 'upstream-skill')
      fs.mkdirSync(localSkill)
      const yamlPath = localSkill.replaceAll('\\', '/')
      fixture.writeLockfile(
        `lockfileVersion: 1
skills:
  local-managed:
    mode: managed
    source:
      type: local
      path: ${yamlPath}
    revision: local
    integrity: h1
`,
      )
      const exit = await main(['update', 'local-managed'], {
        ...io,
        repositoryRoot: fixture.repositoryRoot,
        homeRoot: fixture.homeRoot,
        isInteractive: false,
      })
      expect(exit).toBe(0)
      expect(io.out()).toContain('local-managed')
      expect(io.err()).toBe('')
    } finally {
      fixture.cleanup()
    }
  })
})

describe('skillbox cache clean', () => {
  it('reports the entries freed', async () => {
    const wiring = createWiring()
    wiring.installer.cleared = 5
    const exit = await main(['cache', 'clean'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('Cleared 5 cache entries.')
  })

  it('keeps the singular form for one entry', async () => {
    const wiring = createWiring()
    wiring.installer.cleared = 1
    const exit = await main(['cache', 'clean'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('Cleared 1 cache entry.')
  })

  it('falls back to the default loader without marketplace wiring (empty cache → 0 entries)', async () => {
    // No marketplace overrides → the default installer adapter counts entries
    // under `homeRoot/cache` before calling core's `clearCache`; an empty or
    // missing cache dir reports 0 and skips the clear entirely.
    const io = capture()
    const exit = await main(['cache', 'clean'], {
      ...io,
      repositoryRoot: process.cwd(),
      homeRoot: process.cwd(),
      isInteractive: false,
    })
    expect(exit).toBe(0)
    expect(io.out()).toContain('Cleared 0 cache entries.')
  })
})

describe('exit-code mapping (exit-codes.ts)', () => {
  it('maps SOURCE_UNSUPPORTED to validation (2)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile(
      `lockfileVersion: 1
skills:
  git-skill:
    mode: managed
    source:
      type: git
      url: https://gitlab.com/x/y
    revision: aaaaaaa
    integrity: h1
`,
    )
    const exit = await main(['update', 'git-skill'], wiring.deps())
    expect(exit).toBe(2)
  })

  it('maps INSTALL_CONFLICT to conflict (3) via passthrough', async () => {
    const wiring = createWiring({ detected: ['claude'] })
    wiring.installer.installError = new SkillboxError(
      ErrorCode.INSTALL_CONFLICT,
      'already installed',
    )
    const exit = await main(['add', 'github:x/y'], wiring.deps())
    expect(exit).toBe(3)
    expect(wiring.io.err()).toContain('already installed')
  })
})
