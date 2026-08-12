import { describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import {
  AgentRegistry,
  ConflictSessionStore,
  ErrorCode,
  LocalProvider,
  SkillboxError,
  addSkill,
  computeSkillIntegrity,
  createLockedSkill,
  emptyLockfile,
  emptyManifest,
  readLockfile,
  readManifest,
  repositoryKey,
  registerProvider,
  writeLockfile,
  writeManifest,
} from '@skillbox/core'
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDetectionResult,
  AgentInstalledSkill,
  AgentLinkOptions,
  AgentUnlinkResult,
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult as CoreRegistrySearchResult,
  ResolvedSource,
} from '@skillbox/core'
import type {
  DiffService,
  InstallResult,
  InstallService,
  OutdatedSkill,
  RegistrySearchOptions,
  RegistrySearchResult,
  RegistrySearchService,
  UpdatesService,
} from './types.js'
import type { SkillDiff } from '@skillbox/core'
import { createWebServices } from './services.js'
import { createWebApp } from './app.js'

/**
 * GAP 1.2 — `GET /api/settings` / `PUT /api/settings` — validates the editable
 * subset of the Machine Config, deep-merges patches so untouched fields
 * survive, and persists the result to `~/.skillbox/config.json`.
 */
describe('GET /api/settings', () => {
  it('returns the empty config when no config file exists yet', async () => {
    await withApp(async (app) => {
      const response = await app.request('/api/settings')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { settings: unknown }
      expect(body.settings).toEqual({})
    })
  })

  it('returns the config that was persisted by a previous PUT', async () => {
    await withApp(async (app) => {
      await putSettings(app, { linkStrategy: 'copy' })
      const response = await app.request('/api/settings')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { settings: { linkStrategy: string } }
      expect(body.settings.linkStrategy).toBe('copy')
    })
  })
})

describe('durable sync conflict API', () => {
  it('reads a pending conflict session from the durable Core store', async () => {
    await withApp(async (app, paths) => {
      const session: import('@skillbox/core').ConflictSession = {
        version: 1 as const,
        id: 'session-one',
        repositoryId: repositoryKey(paths.repository),
        baseRevision: 'a'.repeat(40),
        localRevision: 'b'.repeat(40),
        remoteRevision: 'c'.repeat(40),
        snapshotId: 'restore-one',
        createdAt: '2026-08-13T00:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        conflicts: [
          {
            id: 'demo:content',
            type: 'content' as const,
            skillAlias: 'demo',
            path: 'SKILL.md',
            allowedResolutions: ['local', 'remote', 'keep-both'],
            destructive: false,
          },
        ],
      }
      await new ConflictSessionStore({
        repositoryRoot: paths.repository,
        homeRoot: paths.home,
      }).save(session)

      const list = await app.request('/api/conflicts')
      expect(list.status).toBe(200)
      await expect(list.json()).resolves.toMatchObject({ conflicts: [{ id: 'session-one' }] })

      const status = await app.request('/api/sync/status')
      expect(status.status).toBe(200)
      await expect(status.json()).resolves.toMatchObject({
        sync: { kind: 'conflicts', sessionId: 'session-one' },
      })

      const detail = await app.request('/api/conflicts/session-one')
      expect(detail.status).toBe(200)
      await expect(detail.json()).resolves.toMatchObject({
        conflict: { snapshotId: 'restore-one' },
      })
    })
  })
})

describe('PUT /api/settings', () => {
  it('merges only the touched fields and preserves untouched ones', async () => {
    await withApp(async (app, { configPath, home }) => {
      await writeFile(
        configPath,
        JSON.stringify({ repository: '/c/repo', linkStrategy: 'symlink', web: { open: false } }),
      )
      const response = await putSettings(app, { web: { port: 4321 } })
      expect(response.status).toBe(200)

      const body = (await response.json()) as {
        settings: { repository: string; linkStrategy: string; web: { port: number; open: boolean } }
      }
      expect(body.settings).toEqual({
        repository: '/c/repo',
        linkStrategy: 'symlink',
        web: { port: 4321, open: false },
      })

      const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      expect(persisted.repository).toBe('/c/repo')

      await rm(home, { recursive: true, force: true })
    })
  })

  it('writes agent path overrides and clears them with an empty path', async () => {
    await withApp(async (app, { configPath, home }) => {
      await putSettings(app, {
        agents: { claude: { path: '/mnt/claude', executable: 'claude' } },
      })
      await putSettings(app, { agents: { claude: { path: '' } } })

      const body = (await (await app.request('/api/settings')).json()) as {
        settings: { agents?: Record<string, unknown> }
      }
      expect(body.settings.agents).toBeUndefined()
      const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      expect(persisted.agents).toBeUndefined()

      await rm(home, { recursive: true, force: true })
    })
  })

  it('replaces a prior executable-only override when a path is set', async () => {
    await withApp(async (app, { configPath, home }) => {
      await writeFile(configPath, JSON.stringify({ agents: { codex: { executable: '/x/cx' } } }))
      const response = await putSettings(app, { agents: { codex: { path: '/y/cx' } } })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        settings: { agents: { codex: { path: string; executable?: string } } }
      }
      expect(body.settings.agents?.codex).toEqual({ path: '/y/cx' })

      await rm(home, { recursive: true, force: true })
    })
  })

  it('rejects an unknown link strategy with an INVALID_REQUEST envelope', async () => {
    await withApp(async (app) => {
      const response = await putSettings(app, { linkStrategy: 'hardlink' })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('rejects a missing "settings" body with an INVALID_REQUEST envelope', async () => {
    await withApp(async (app) => {
      const response = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ web: { port: 1 } }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('rejects an out-of-range web port with an INVALID_REQUEST envelope', async () => {
    await withApp(async (app) => {
      const response = await putSettings(app, { web: { port: 70000 } })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('rejects a malformed agent override with an INVALID_REQUEST envelope', async () => {
    await withApp(async (app) => {
      const response = await putSettings(app, { agents: { claude: { executable: '/x' } } })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })
})

/* ---- V0.3 registry API (M14.7 search / M15 install / M16.3 updates) ---- */

const SEARCH_RESULTS: RegistrySearchResult[] = [
  {
    name: 'react-best-practices',
    source: 'github:acme/react-best-practices',
    provider: 'github',
    description: 'Opinionated React patterns',
    popularity: 4200,
    trending: true,
    official: false,
    securityReviewed: true,
    securityRisk: 'low',
  },
  {
    name: 'shell-guard',
    source: 'skills-sh:acme/shell-guard',
    provider: 'skills-sh',
    description: 'Safe shell scripting',
    popularity: 900,
    official: true,
    securityReviewed: false,
  },
]

const OUTDATED_ROWS: OutdatedSkill[] = [
  {
    name: 'react-best-practices',
    source: 'github:acme/react-best-practices',
    installed: 'a1b2c3d',
    latest: 'e5f6a7b',
    changes: ['Updated hooks guidance', 'Dropped legacy lifecycle section'],
    agents: ['claude', 'codex'],
  },
]

const INSTALL_RESULT: InstallResult = {
  name: 'react-best-practices',
  source: 'github:acme/react-best-practices',
  revision: 'e5f6a7b',
  path: '/repo/.skillbox/skills/react-best-practices',
  security: { risk: 'low', findings: [] },
  agents: ['claude'],
  manifestChanged: true,
  lockfileChanged: true,
}

describe('GET /api/registry/search', () => {
  it('returns the aggregated search results for a query', async () => {
    await withRegistryApp({ searchResults: SEARCH_RESULTS }, async (app) => {
      const response = await app.request('/api/registry/search?q=react')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { results: RegistrySearchResult[] }
      expect(body.results).toHaveLength(2)
      expect(body.results[0]?.name).toBe('react-best-practices')
    })
  })

  it('forwards the trending/official/sort/provider filters to the service', async () => {
    const calls: { query: string; options: RegistrySearchOptions }[] = []
    await withRegistryApp(
      {
        searchResults: SEARCH_RESULTS,
        onSearch: (query, options) => {
          calls.push({ query, options })
        },
      },
      async (app) => {
        const response = await app.request(
          '/api/registry/search?q=react&trending=1&official=true&sort=popularity&provider=github',
        )
        expect(response.status).toBe(200)
        expect(calls).toEqual([
          {
            query: 'react',
            options: { provider: 'github', sort: 'popularity', trending: true, official: true },
          },
        ])
      },
    )
  })

  it('answers an empty result list for a bare browse request', async () => {
    await withRegistryApp({ searchResults: [] }, async (app) => {
      const response = await app.request('/api/registry/search')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { results: unknown[] }
      expect(body.results).toEqual([])
    })
  })

  it('maps a REGISTRY_UNAVAILABLE failure to a 503 envelope', async () => {
    await withRegistryApp(
      {
        searchError: new SkillboxError(ErrorCode.REGISTRY_UNAVAILABLE, 'offline', {
          recoverable: true,
        }),
      },
      async (app) => {
        const response = await app.request('/api/registry/search?q=react')
        expect(response.status).toBe(503)
        const body = (await response.json()) as { error: { code: string; recoverable: boolean } }
        expect(body.error.code).toBe('REGISTRY_UNAVAILABLE')
        expect(body.error.recoverable).toBe(true)
      },
    )
  })
})

describe('GET /api/registry/outdated', () => {
  it('returns the outdated skills with change notes', async () => {
    await withRegistryApp({ outdatedRows: OUTDATED_ROWS }, async (app) => {
      const response = await app.request('/api/registry/outdated')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { outdated: OutdatedSkill[] }
      expect(body.outdated).toHaveLength(1)
      expect(body.outdated[0]?.installed).toBe('a1b2c3d')
      expect(body.outdated[0]?.latest).toBe('e5f6a7b')
      expect(body.outdated[0]?.changes).toHaveLength(2)
    })
  })

  it('maps an upstream failure to the M10.8 envelope', async () => {
    await withRegistryApp(
      {
        outdatedError: new SkillboxError(ErrorCode.REGISTRY_UNAVAILABLE, 'offline', {
          recoverable: true,
        }),
      },
      async (app) => {
        const response = await app.request('/api/registry/outdated')
        expect(response.status).toBe(503)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('REGISTRY_UNAVAILABLE')
      },
    )
  })
})

describe('POST /api/registry/install', () => {
  it('installs a skill and returns the transaction summary', async () => {
    const calls: { source: string; targetAgents: string[]; allowPolicy: 'safe' | 'all' }[] = []
    await withRegistryApp(
      {
        installResult: INSTALL_RESULT,
        onInstall: (input) => {
          calls.push(input)
        },
      },
      async (app) => {
        const response = await postInstall(app, {
          source: 'github:acme/react-best-practices',
          targetAgents: ['claude'],
          allowPolicy: 'safe',
        })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { installed: InstallResult }
        expect(body.installed.name).toBe('react-best-practices')
        expect(body.installed.manifestChanged).toBe(true)
        expect(body.installed.lockfileChanged).toBe(true)
        expect(calls).toEqual([
          {
            source: 'github:acme/react-best-practices',
            targetAgents: ['claude'],
            allowPolicy: 'safe',
          },
        ])
      },
    )
  })

  it('rejects a missing targetAgents list with INVALID_REQUEST', async () => {
    await withRegistryApp({ installResult: INSTALL_RESULT }, async (app) => {
      const response = await postInstall(app, {
        source: 'github:acme/react-best-practices',
        allowPolicy: 'safe',
      } as unknown as Record<string, unknown>)
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('rejects an empty targetAgents list with INVALID_REQUEST', async () => {
    await withRegistryApp({ installResult: INSTALL_RESULT }, async (app) => {
      const response = await postInstall(app, {
        source: 'github:acme/react-best-practices',
        targetAgents: [],
        allowPolicy: 'safe',
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('rejects an unknown allowPolicy with INVALID_REQUEST', async () => {
    await withRegistryApp({ installResult: INSTALL_RESULT }, async (app) => {
      const response = await postInstall(app, {
        source: 'github:acme/react-best-practices',
        targetAgents: ['claude'],
        allowPolicy: 'sometimes',
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('maps INSTALL_SECURITY_BLOCKED to a 403 with the retry hint flag', async () => {
    await withRegistryApp(
      {
        installError: new SkillboxError(ErrorCode.INSTALL_SECURITY_BLOCKED, 'high risk', {
          recoverable: true,
        }),
      },
      async (app) => {
        const response = await postInstall(app, {
          source: 'github:acme/shell-guard',
          targetAgents: ['claude'],
          allowPolicy: 'safe',
        })
        expect(response.status).toBe(403)
        const body = (await response.json()) as { error: { code: string; recoverable: boolean } }
        expect(body.error.code).toBe('INSTALL_SECURITY_BLOCKED')
        expect(body.error.recoverable).toBe(true)
      },
    )
  })
})

interface Paths {
  configPath: string
  home: string
  repository: string
}

interface RegistryFakes {
  searchResults?: RegistrySearchResult[]
  searchError?: unknown
  outdatedRows?: OutdatedSkill[]
  outdatedError?: unknown
  installResult?: InstallResult
  installError?: unknown
  onSearch?: (query: string, options: RegistrySearchOptions) => void
  onInstall?: (input: {
    source: string
    targetAgents: string[]
    allowPolicy: 'safe' | 'all'
  }) => void
}

/** App wired with fake V0.3 registry/updates/install services. */
async function withRegistryApp(
  fakes: RegistryFakes,
  run: (app: Hono) => Promise<void>,
): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-registry-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'skillbox-web-registry-home-'))
  try {
    const search: RegistrySearchService = {
      async search(query, options) {
        if (fakes.searchError !== undefined) {
          throw fakes.searchError
        }
        fakes.onSearch?.(query, options ?? {})
        return fakes.searchResults ?? []
      },
    }
    const updates: UpdatesService = {
      async outdated() {
        if (fakes.outdatedError !== undefined) {
          throw fakes.outdatedError
        }
        return fakes.outdatedRows ?? []
      },
    }
    const install: InstallService = {
      async install(input) {
        if (fakes.installError !== undefined) {
          throw fakes.installError
        }
        if (fakes.installResult === undefined) {
          throw new Error('no installResult fake configured')
        }
        fakes.onInstall?.(input)
        return fakes.installResult
      },
    }
    const services = createWebServices({
      repositoryRoot: repository,
      homeRoot: home,
      search,
      updates,
      install,
    })
    const app = createWebApp({ services })
    await run(app)
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

function postInstall(app: Hono, body: Record<string, unknown>): ReturnType<Hono['request']> {
  return app.request('/api/registry/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function withApp(run: (app: Hono, paths: Paths) => Promise<void>): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-api-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'skillbox-web-api-home-'))
  try {
    const services = createWebServices({ repositoryRoot: repository, homeRoot: home })
    const app = createWebApp({ services })
    await run(app, { configPath: join(home, 'config.json'), home, repository })
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

function putSettings(app: Hono, settings: Record<string, unknown>): ReturnType<Hono['request']> {
  return app.request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
}

/* ---- V0.3 registry API over the real Core-backed default services ---- */

/**
 * Hermetic remote provider: answers no search hits, reports a fixed latest
 * revision, and never touches the network.
 */
function stubProvider(id: string, latestRevision: string): RegistryProvider {
  return {
    id,
    async search(): Promise<CoreRegistrySearchResult[]> {
      return []
    },
    async resolve(source: NormalizedSource): Promise<ResolvedSource> {
      return { source, revision: latestRevision }
    },
    async download(): Promise<void> {},
    async getLatestRevision(): Promise<string> {
      return latestRevision
    },
  }
}

/** GitHub provider backed by a local seed directory (no network). */
class FakeGithubProvider implements RegistryProvider {
  readonly id = 'github'

  constructor(
    private readonly seedDir: string,
    private readonly revision: string,
  ) {}

  async search(): Promise<CoreRegistrySearchResult[]> {
    return []
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    return { source, revision: this.revision }
  }

  async download(_source: NormalizedSource, _revision: string, targetDir: string): Promise<void> {
    await cp(this.seedDir, targetDir, { recursive: true })
  }

  async getLatestRevision(): Promise<string> {
    return this.revision
  }
}

/**
 * GitHub provider serving per-revision fixture directories (used by the diff
 * tests to simulate upstream history): `download` copies the fixture of the
 * requested revision, and "latest" is whatever the test pins.
 */
class RevisionsGithubProvider implements RegistryProvider {
  readonly id = 'github'

  constructor(
    private readonly revisions: Map<string, string>,
    private readonly latestRevision: string,
  ) {}

  async search(): Promise<CoreRegistrySearchResult[]> {
    return []
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    return { source, revision: this.latestRevision }
  }

  async download(_source: NormalizedSource, revision: string, targetDir: string): Promise<void> {
    const fixture = this.revisions.get(revision)
    if (fixture === undefined) {
      throw new Error(`unknown revision ${revision}`)
    }
    await cp(fixture, targetDir, { recursive: true })
  }

  async getLatestRevision(): Promise<string> {
    return this.latestRevision
  }
}

/** Fake agent adapter materializing links as plain directories (no real agent config). */
class FakeAgentAdapter implements AgentAdapter {
  readonly name: string
  readonly capabilities: AgentCapabilities = {
    supportsGlobalSkills: true,
    supportsProjectSkills: true,
    supportsSymlinks: true,
    supportsNestedSkillDirectories: false,
    requiresRestartAfterChange: false,
  }
  readonly createdLinks: string[] = []

  constructor(
    readonly id: string,
    private readonly dir: string,
  ) {
    this.name = id
  }

  async detect(): Promise<AgentDetectionResult> {
    return { detected: true, skillDirectories: [this.dir], confidence: 'high' }
  }

  async getSkillDirectories(): Promise<string[]> {
    return [this.dir]
  }

  async scanSkills(): Promise<AgentInstalledSkill[]> {
    return []
  }

  async linkSkill(_source: string, options?: AgentLinkOptions): Promise<void> {
    const name = options?.name ?? 'skill'
    this.createdLinks.push(name)
    await mkdir(join(this.dir, name), { recursive: true })
  }

  async unlinkSkill(name: string): Promise<AgentUnlinkResult> {
    await rm(join(this.dir, name), { recursive: true, force: true })
    return { name, path: join(this.dir, name), removed: true, reason: 'managed' }
  }
}

interface RealServicesContext {
  app: Hono
  repository: string
  home: string
  registryDir: string
  agentDir: string
}

/**
 * App wired with the *real* Core-backed search/updates/install services over a
 * hermetic process-wide `defaultRegistry` (stub remote providers, local
 * provider rooted at a temp dir) and a fake agent adapter — no network and no
 * real agent config directories are ever touched. `setup` runs after the
 * hermetic defaults are registered but before the services are built, so tests
 * can swap in their own providers (e.g. a seeded github provider).
 */
async function withRealRegistryApp(
  run: (context: RealServicesContext) => Promise<void>,
  setup?: (context: Omit<RealServicesContext, 'app'>) => Promise<void> | void,
): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-real-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'skillbox-web-real-home-'))
  const registryDir = await mkdtemp(join(tmpdir(), 'skillbox-web-real-registry-'))
  const agentDir = await mkdtemp(join(tmpdir(), 'skillbox-web-real-agent-'))
  try {
    registerProvider(stubProvider('github', 'latest-sha'))
    registerProvider(stubProvider('skills-sh', 'latest-sha'))
    registerProvider(new LocalProvider({ root: registryDir }))
    await setup?.({ repository, home, registryDir, agentDir })
    const services = createWebServices({
      repositoryRoot: repository,
      homeRoot: home,
      registry: new AgentRegistry([new FakeAgentAdapter('claude', agentDir)]),
    })
    const app = createWebApp({ services })
    await run({ app, repository, home, registryDir, agentDir })
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(registryDir, { recursive: true, force: true })
    await rm(agentDir, { recursive: true, force: true })
  }
}

describe('V0.3 registry API — real Core-backed services', () => {
  it('serves aggregated search results from the registered local provider', async () => {
    await withRealRegistryApp(async ({ app, registryDir }) => {
      const skillDir = join(registryDir, 'alpha-skill')
      await mkdir(skillDir)
      await writeFile(join(skillDir, 'SKILL.md'), '# Alpha skill\n')

      const response = await app.request('/api/registry/search?q=alpha')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { results: RegistrySearchResult[] }
      expect(body.results).toHaveLength(1)
      expect(body.results[0]).toMatchObject({
        name: 'alpha-skill',
        source: skillDir,
        provider: 'local',
        securityReviewed: false,
        trending: false,
        official: false,
      })
    })
  })

  it('filters search results by the requested provider', async () => {
    await withRealRegistryApp(async ({ app, registryDir }) => {
      await mkdir(join(registryDir, 'beta-skill'))
      await writeFile(join(registryDir, 'beta-skill', 'SKILL.md'), '# Beta\n')

      const response = await app.request('/api/registry/search?q=beta&provider=github')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { results: RegistrySearchResult[] }
      // The github stub answers no hits, so the local hit is filtered out.
      expect(body.results).toEqual([])
    })
  })

  it('answers an empty outdated list when no lockfile exists yet', async () => {
    await withRealRegistryApp(async ({ app }) => {
      const response = await app.request('/api/registry/outdated')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { outdated: unknown[] }
      expect(body.outdated).toEqual([])
    })
  })

  it('reports outdated managed skills from the lockfile against provider latest revisions', async () => {
    await withRealRegistryApp(
      async ({ app, repository }) => {
        const lockfile = emptyLockfile()
        lockfile.skills['hello'] = createLockedSkill({
          mode: 'managed',
          source: { type: 'github', repo: 'acme/skillz' },
          integrity: `sha256:${'a'.repeat(64)}`,
          revision: 'a1b2c3d',
        })
        // Up to date: its pinned revision equals the stub provider's latest.
        lockfile.skills['current'] = createLockedSkill({
          mode: 'managed',
          source: { type: 'github', repo: 'acme/current' },
          integrity: `sha256:${'b'.repeat(64)}`,
          revision: 'e5f6a7b',
        })
        await writeLockfile(repository, lockfile)
        await writeManifest(
          repository,
          addSkill(emptyManifest(), 'hello', {
            source: { type: 'github', repo: 'acme/skillz' },
            agents: ['claude'],
          }),
        )

        const response = await app.request('/api/registry/outdated')
        expect(response.status).toBe(200)
        const body = (await response.json()) as { outdated: OutdatedSkill[] }
        expect(body.outdated).toHaveLength(1)
        expect(body.outdated[0]).toMatchObject({
          name: 'hello',
          source: 'github:acme/skillz',
          installed: 'a1b2c3d',
          latest: 'e5f6a7b',
          changes: [],
          agents: ['claude'],
        })
      },
      () => {
        registerProvider(stubProvider('github', 'e5f6a7b'))
      },
    )
  })

  it('installs a remote skill through the real install transaction', async () => {
    await withRealRegistryApp(
      async ({ app, repository }) => {
        const response = await postInstall(app, {
          source: 'github:acme/skillz@skills/hello',
          targetAgents: ['claude'],
          allowPolicy: 'safe',
        })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { installed: InstallResult }
        expect(body.installed).toMatchObject({
          name: 'hello',
          source: 'github:acme/skillz@skills/hello',
          revision: 'abc123',
          security: { risk: 'low', findings: [] },
          agents: ['claude'],
          manifestChanged: true,
          lockfileChanged: true,
        })
        expect(body.installed.path).toMatch(/managed[\\/]hello$/)

        // The repository gained a manifest + lockfile entry; the library copy exists.
        const manifest = await readManifest(repository)
        expect(manifest.skills['hello']?.agents).toEqual(['claude'])
        const lockfile = await readLockfile(repository)
        expect(lockfile.skills['hello']?.revision).toBe('abc123')
      },
      async ({ home }) => {
        const seed = join(home, 'seed-repo')
        await mkdir(join(seed, 'skills', 'hello'), { recursive: true })
        await writeFile(join(seed, 'skills', 'hello', 'SKILL.md'), '# Hello\n')
        registerProvider(new FakeGithubProvider(seed, 'abc123'))
      },
    )
  })

  it('rejects a local source install with a 400 SOURCE_UNSUPPORTED envelope', async () => {
    await withRealRegistryApp(async ({ app, registryDir }) => {
      const response = await postInstall(app, {
        source: join(registryDir, 'alpha-skill'),
        targetAgents: ['claude'],
        allowPolicy: 'safe',
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('SOURCE_UNSUPPORTED')
    })
  })

  it('rejects an unparseable source with a 400 SOURCE_INVALID envelope', async () => {
    await withRealRegistryApp(async ({ app }) => {
      const response = await postInstall(app, {
        source: 'not-a-source',
        targetAgents: ['claude'],
        allowPolicy: 'safe',
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('SOURCE_INVALID')
    })
  })
})

/* ---- V0.4 skill diff API (M19.5) ---- */

const MANAGED_DIFF: SkillDiff = {
  name: 'hello',
  mode: 'managed',
  unchanged: false,
  views: [
    {
      label: 'Current vs Latest',
      files: [
        { path: 'SKILL.md', status: 'modified', patch: '-# Hello\n+# Hello (updated)\n' },
        { path: 'logo.png', status: 'modified', patch: '', binary: true },
      ],
    },
  ],
}

const FORKED_DIFF: SkillDiff = {
  name: 'hello',
  mode: 'forked',
  unchanged: false,
  views: [
    {
      label: 'Base vs Local',
      files: [{ path: 'SKILL.md', status: 'modified', patch: '-a\n+b\n' }],
    },
    { label: 'Local vs Latest', files: [] },
    {
      label: 'Base vs Latest',
      files: [
        { path: 'SKILL.md', status: 'modified', patch: '-a\n+c\n' },
        { path: 'README.md', status: 'added', patch: '+readme\n' },
      ],
    },
  ],
}

describe('GET /api/skills/:id/diff', () => {
  it('returns the diff envelope of a managed skill (one Current vs Latest view)', async () => {
    const calls: string[] = []
    await withDiffApp(
      { diffResult: MANAGED_DIFF, onDiff: (name) => calls.push(name) },
      async (app) => {
        const response = await app.request('/api/skills/hello/diff')
        expect(response.status).toBe(200)
        const body = (await response.json()) as { diff: SkillDiff }
        expect(body.diff.name).toBe('hello')
        expect(body.diff.mode).toBe('managed')
        expect(body.diff.views.map((view) => view.label)).toEqual(['Current vs Latest'])
        expect(body.diff.views[0]?.files[1]).toMatchObject({ path: 'logo.png', binary: true })
        expect(calls).toEqual(['hello'])
      },
    )
  })

  it('returns the three forked views as-is', async () => {
    await withDiffApp({ diffResult: FORKED_DIFF }, async (app) => {
      const response = await app.request('/api/skills/hello/diff')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { diff: SkillDiff }
      expect(body.diff.views.map((view) => view.label)).toEqual([
        'Base vs Local',
        'Local vs Latest',
        'Base vs Latest',
      ])
      expect(body.diff.views[0]?.files[0]?.status).toBe('modified')
      expect(body.diff.views[2]?.files[1]?.status).toBe('added')
    })
  })

  it('maps SKILL_NOT_FOUND to a 404 envelope', async () => {
    await withDiffApp(
      {
        diffError: new SkillboxError(
          ErrorCode.SKILL_NOT_FOUND,
          'Skill "nope" is not in the manifest',
          {
            context: { name: 'nope' },
          },
        ),
      },
      async (app) => {
        const response = await app.request('/api/skills/nope/diff')
        expect(response.status).toBe(404)
        const body = (await response.json()) as { error: { code: string; recoverable: boolean } }
        expect(body.error.code).toBe('SKILL_NOT_FOUND')
        expect(body.error.recoverable).toBe(false)
      },
    )
  })

  it('maps DIFF_UPSTREAM_UNAVAILABLE to a 409 envelope', async () => {
    await withDiffApp(
      {
        diffError: new SkillboxError(ErrorCode.DIFF_UPSTREAM_UNAVAILABLE, 'no upstream', {
          context: { name: 'hello', mode: 'local' },
        }),
      },
      async (app) => {
        const response = await app.request('/api/skills/hello/diff')
        expect(response.status).toBe(409)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('DIFF_UPSTREAM_UNAVAILABLE')
      },
    )
  })
})

interface DiffFakes {
  diffResult?: SkillDiff
  diffError?: unknown
  onDiff?: (name: string) => void
}

/** App wired with a fake diff service (M19.5 route wiring + envelope tests). */
async function withDiffApp(fakes: DiffFakes, run: (app: Hono) => Promise<void>): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-diff-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'skillbox-web-diff-home-'))
  try {
    const diff: DiffService = {
      async diffSkill(name) {
        if (fakes.diffError !== undefined) {
          throw fakes.diffError
        }
        if (fakes.diffResult === undefined) {
          throw new Error('no diffResult fake configured')
        }
        fakes.onDiff?.(name)
        return fakes.diffResult
      },
    }
    const services = createWebServices({ repositoryRoot: repository, homeRoot: home, diff })
    const app = createWebApp({ services })
    await run(app)
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

describe('GET /api/skills/:id/diff — real Core-backed diff service', () => {
  it('answers "unchanged" for a managed skill pinned at the latest revision', async () => {
    await withRealRegistryApp(
      async ({ app }) => {
        const response = await app.request('/api/skills/hello/diff')
        expect(response.status).toBe(200)
        const body = (await response.json()) as { diff: SkillDiff }
        expect(body.diff).toMatchObject({
          name: 'hello',
          mode: 'managed',
          unchanged: true,
        })
        expect(body.diff.views.map((view) => view.label)).toEqual(['Current vs Latest'])
        expect(body.diff.views[0]?.files).toEqual([])
      },
      async ({ repository, home }) => {
        const rev1 = join(home, 'seed-rev1')
        await mkdir(rev1)
        await writeFile(join(rev1, 'SKILL.md'), '# Hello\n')
        const source = { type: 'github' as const, repo: 'acme/skillz', ref: 'main' }
        const manifest = addSkill(emptyManifest(), 'hello', { source })
        await writeManifest(repository, manifest)
        const lockfile = emptyLockfile()
        const locked = createLockedSkill({
          mode: 'managed',
          source,
          integrity: `sha256:${'a'.repeat(64)}`,
        })
        locked.revision = 'rev1'
        locked.upstream = { source, baseRevision: 'rev1', latestRevision: 'rev1' }
        lockfile.skills.hello = locked
        await writeLockfile(repository, lockfile)
        registerProvider(new FakeGithubProvider(rev1, 'rev1'))
      },
    )
  })

  it('reports modified/deleted files with unified patches for a managed skill behind upstream', async () => {
    await withRealRegistryApp(
      async ({ app }) => {
        const response = await app.request('/api/skills/hello/diff')
        expect(response.status).toBe(200)
        const body = (await response.json()) as { diff: SkillDiff }
        expect(body.diff).toMatchObject({ name: 'hello', mode: 'managed', unchanged: false })
        expect(body.diff.views).toHaveLength(1)
        const files = body.diff.views[0]?.files ?? []
        expect(files.map((file) => file.path).sort()).toEqual(['README.md', 'SKILL.md'])
        expect(files.find((file) => file.path === 'SKILL.md')?.status).toBe('modified')
        expect(files.find((file) => file.path === 'SKILL.md')?.patch).toContain(
          '+# Hello (updated)',
        )
        expect(files.find((file) => file.path === 'README.md')?.status).toBe('deleted')
      },
      async ({ repository, home }) => {
        const rev1 = join(home, 'seed-rev1')
        await mkdir(rev1)
        await writeFile(join(rev1, 'SKILL.md'), '# Hello\n')
        await writeFile(join(rev1, 'README.md'), 'readme\n')
        const rev2 = join(home, 'seed-rev2')
        await mkdir(rev2)
        await writeFile(join(rev2, 'SKILL.md'), '# Hello (updated)\n')
        const source = { type: 'github' as const, repo: 'acme/skillz', ref: 'main' }
        const manifest = addSkill(emptyManifest(), 'hello', { source })
        await writeManifest(repository, manifest)
        const lockfile = emptyLockfile()
        const locked = createLockedSkill({
          mode: 'managed',
          source,
          integrity: `sha256:${'a'.repeat(64)}`,
        })
        locked.revision = 'rev1'
        locked.upstream = { source, baseRevision: 'rev1', latestRevision: 'rev2' }
        lockfile.skills.hello = locked
        await writeLockfile(repository, lockfile)
        registerProvider(
          new RevisionsGithubProvider(
            new Map([
              ['rev1', rev1],
              ['rev2', rev2],
            ]),
            'rev2',
          ),
        )
      },
    )
  })

  it('returns the three forked views Base vs Local / Local vs Latest / Base vs Latest', async () => {
    await withRealRegistryApp(
      async ({ app }) => {
        const response = await app.request('/api/skills/hello/diff')
        expect(response.status).toBe(200)
        const body = (await response.json()) as { diff: SkillDiff }
        expect(body.diff).toMatchObject({ name: 'hello', mode: 'forked', unchanged: false })
        expect(body.diff.views.map((view) => view.label)).toEqual([
          'Base vs Local',
          'Local vs Latest',
          'Base vs Latest',
        ])
        const [baseLocal, localLatest, baseLatest] = body.diff.views
        expect(baseLocal?.files.map((file) => file.path).sort()).toEqual(['SKILL.md', 'notes.md'])
        expect(baseLocal?.files.find((file) => file.path === 'SKILL.md')?.status).toBe('modified')
        expect(localLatest?.files.map((file) => file.path).sort()).toEqual([
          'README.md',
          'SKILL.md',
          'notes.md',
        ])
        expect(baseLatest?.files.map((file) => file.path).sort()).toEqual(['README.md', 'SKILL.md'])
      },
      async ({ repository, home }) => {
        const localDir = join(repository, 'skills', 'hello')
        await mkdir(localDir, { recursive: true })
        await writeFile(join(localDir, 'SKILL.md'), '# Hello (local edit)\n')
        await writeFile(join(localDir, 'notes.md'), 'local notes\n')
        const rev1 = join(home, 'seed-rev1')
        await mkdir(rev1)
        await writeFile(join(rev1, 'SKILL.md'), '# Hello\n')
        const rev2 = join(home, 'seed-rev2')
        await mkdir(rev2)
        await writeFile(join(rev2, 'SKILL.md'), '# Hello (upstream)\n')
        await writeFile(join(rev2, 'README.md'), 'upstream readme\n')
        const source = { type: 'local' as const, path: 'skills/hello' }
        const manifest = addSkill(emptyManifest(), 'hello', {
          source,
          mode: 'forked',
          upstream: { type: 'github', repo: 'acme/skillz' },
        })
        await writeManifest(repository, manifest)
        const lockfile = emptyLockfile()
        const locked = createLockedSkill({
          mode: 'forked',
          source,
          integrity: await computeSkillIntegrity(localDir),
        })
        locked.upstream = {
          source: { type: 'github', repo: 'acme/skillz' },
          baseRevision: 'rev1',
          latestRevision: 'rev2',
        }
        lockfile.skills.hello = locked
        await writeLockfile(repository, lockfile)
        registerProvider(
          new RevisionsGithubProvider(
            new Map([
              ['rev1', rev1],
              ['rev2', rev2],
            ]),
            'rev2',
          ),
        )
      },
    )
  })

  it('answers a 404 SKILL_NOT_FOUND envelope for an unknown skill', async () => {
    await withRealRegistryApp(
      async ({ app }) => {
        const response = await app.request('/api/skills/nope/diff')
        expect(response.status).toBe(404)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('SKILL_NOT_FOUND')
      },
      async ({ repository }) => {
        await writeManifest(repository, emptyManifest())
        await writeLockfile(repository, emptyLockfile())
      },
    )
  })

  it('answers a 409 DIFF_UPSTREAM_UNAVAILABLE envelope for a local skill without upstream', async () => {
    await withRealRegistryApp(
      async ({ app }) => {
        const response = await app.request('/api/skills/hello/diff')
        expect(response.status).toBe(409)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('DIFF_UPSTREAM_UNAVAILABLE')
      },
      async ({ repository }) => {
        const manifest = addSkill(emptyManifest(), 'hello', {
          source: { type: 'local', path: 'skills/hello' },
        })
        await writeManifest(repository, manifest)
        await writeLockfile(repository, emptyLockfile())
      },
    )
  })
})
