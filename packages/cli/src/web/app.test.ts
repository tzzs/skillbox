import { describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createAdaptorServer } from '@hono/node-server'
import {
  AgentRegistry,
  emitSkillboxEvent,
  ErrorCode,
  FleetService,
  LocalProvider,
  SkillboxError,
  SshClient,
  addSkill,
  computeSkillIntegrity,
  createLockedSkill,
  emptyLockfile,
  emptyManifest,
  readLockfile,
  readManifest,
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
  ConflictSession,
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult as CoreRegistrySearchResult,
  RepositorySync,
  ResolvedSource,
  SyncOutcome,
  SyncSnapshot,
} from '@skillbox/core'
import type {
  DiffService,
  InstallResult,
  InstallService,
  LifecycleService,
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

  it('persists the personal-library block and trims its ignore lists', async () => {
    await withApp(async (app, { configPath, home }) => {
      const response = await putSettings(app, {
        library: { autoAdopt: false, ignoreAgents: ['  Cursor '], ignoreSkills: ['scratch'] },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        settings: { library?: { autoAdopt?: boolean; ignoreAgents?: string[] } }
      }
      expect(body.settings.library).toEqual({
        autoAdopt: false,
        ignoreAgents: ['Cursor'],
        ignoreSkills: ['scratch'],
      })

      const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      expect(persisted.library).toMatchObject({ autoAdopt: false, ignoreAgents: ['Cursor'] })

      await rm(home, { recursive: true, force: true })
    })
  })

  it('rejects a malformed personal-library block', async () => {
    await withApp(async (app, { home }) => {
      for (const settings of [
        { library: { autoAdopt: 'no' } },
        { library: { ignoreAgents: [''] } },
        { library: { ignoreSkills: 'scratch' } },
        { library: {} },
      ]) {
        const response = await putSettings(app, settings)
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_REQUEST')
      }

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

describe('POST /api/skills', () => {
  it('creates a skill without a description — the field is optional', async () => {
    await withApp(async (app) => {
      const response = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'demo-skill' }),
      })
      expect(response.status).toBe(201)
      const body = (await response.json()) as { created: { name: string } }
      expect(body.created.name).toBe('demo-skill')
    })
  })

  it('creates a skill with a description', async () => {
    await withApp(async (app) => {
      const response = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'demo-skill', description: 'A demo skill' }),
      })
      expect(response.status).toBe(201)
      const body = (await response.json()) as { created: { name: string } }
      expect(body.created.name).toBe('demo-skill')
    })
  })

  it('rejects a missing name', async () => {
    await withApp(async (app) => {
      const response = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })
})

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
      const body = (await response.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
      // The Updates batch shows this message per failed row, so it has to name
      // the rejected field rather than being an empty or generic string.
      expect(body.error.message).toContain('targetAgents')
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
        const body = (await response.json()) as {
          error: { code: string; message: string; recoverable: boolean }
        }
        expect(body.error.code).toBe('INSTALL_SECURITY_BLOCKED')
        expect(body.error.recoverable).toBe(true)
        // The Core message reaches the client verbatim — the Updates page
        // prints it as the reason of the matching failed row.
        expect(body.error.message).toBe('high risk')
      },
    )
  })
})

interface Paths {
  configPath: string
  home: string
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
    await run(app, { configPath: join(home, 'config.json'), home })
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

  async download(source: NormalizedSource, _revision: string, targetDir: string): Promise<void> {
    // Real providers materialize the skill *subtree* into `targetDir`.
    const subPath = source.type === 'github' ? source.path : undefined
    const seedRoot =
      subPath === undefined ? this.seedDir : join(this.seedDir, ...subPath.split('/'))
    await cp(seedRoot, targetDir, { recursive: true })
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

/* ---- V0.4 lifecycle API (M17 fork / M18 vendor / M17.3 restore / M20 merge) ---- */

/**
 * Seeds a managed skill (library copy + manifest + lockfile with a pinned
 * revision) so the real Core lifecycle transactions have something to act on.
 */
async function seedManagedSkillWeb(
  context: { repository: string; home: string },
  alias = 'hello',
): Promise<{ integrity: string; upstream: NormalizedSource }> {
  const managedPath = join(context.home, 'library', 'managed', alias)
  await mkdir(managedPath, { recursive: true })
  await writeFile(join(managedPath, 'SKILL.md'), '# Hello\n')
  await writeFile(join(managedPath, 'notes.md'), 'original\n')
  const upstream: NormalizedSource = {
    type: 'github',
    repo: 'acme/skillz',
    path: 'skills/hello',
    ref: 'main',
  }
  const integrity = await computeSkillIntegrity(managedPath)
  await writeManifest(
    context.repository,
    addSkill(emptyManifest(), alias, { source: upstream, mode: 'managed' }),
  )
  const locked = createLockedSkill({
    mode: 'managed',
    source: upstream,
    integrity,
    revision: 'abc123',
  })
  locked.upstream = {
    source: upstream,
    baseRevision: 'abc123',
    baseIntegrity: integrity,
    latestRevision: 'abc123',
  }
  const lockfile = emptyLockfile()
  lockfile.skills[alias] = locked
  await writeLockfile(context.repository, lockfile)
  return { integrity, upstream }
}

describe('V0.4 lifecycle API — real Core transactions', () => {
  it('forks a managed skill (M17.1): 201, mode flips to forked', async () => {
    await withRealRegistryApp(
      async ({ app, repository }) => {
        const response = await app.request('/api/skills/hello/fork', { method: 'POST' })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { result: { action: string } }
        expect(body.result.action).toBe('forked')

        const manifest = await readManifest(repository)
        expect(manifest.skills['hello']?.mode).toBe('forked')
        expect(manifest.skills['hello']?.source).toEqual({
          type: 'local',
          path: 'skills/hello',
        })
        await expect(
          readFile(join(repository, 'skills', 'hello', 'SKILL.md'), 'utf8'),
        ).resolves.toBe('# Hello\n')
      },
      async (context) => {
        await seedManagedSkillWeb(context)
      },
    )
  })

  it('vendors a managed skill (M18): 201, mode flips to vendored', async () => {
    await withRealRegistryApp(
      async ({ app, repository }) => {
        const response = await app.request('/api/skills/hello/vendor', { method: 'POST' })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { result: { action: string } }
        expect(body.result.action).toBe('vendored')

        const manifest = await readManifest(repository)
        expect(manifest.skills['hello']?.mode).toBe('vendored')
      },
      async (context) => {
        await seedManagedSkillWeb(context)
      },
    )
  })

  it('restores a modified managed skill to the pinned revision (M17.3)', async () => {
    await withRealRegistryApp(
      async ({ app, home }) => {
        const response = await app.request('/api/skills/hello/restore', { method: 'POST' })
        expect(response.status).toBe(201)
        const body = (await response.json()) as {
          result: { action: string; filesRestored?: number }
        }
        expect(body.result.action).toBe('restored')
        expect(body.result.filesRestored).toBeGreaterThan(0)

        // The local edit is gone; the runtime matches the pinned content again.
        await expect(
          readFile(join(home, 'library', 'managed', 'hello', 'SKILL.md'), 'utf8'),
        ).resolves.toBe('# Hello\n')
        await expect(
          readFile(join(home, 'library', 'managed', 'hello', 'edited.md'), 'utf8'),
        ).rejects.toThrow()
      },
      async (context) => {
        const seed = await seedManagedSkillWeb(context)
        // Divergence: the user edited the runtime copy locally.
        await writeFile(join(context.home, 'library', 'managed', 'hello', 'edited.md'), 'local\n')
        void seed
        // Provider re-downloads the pinned content. FakeGithubProvider
        // materializes the subtree under `source.path`, so the seed is a
        // full-repo shape with the skill at `skills/hello`.
        const seedDir = join(context.home, 'upstream-seed')
        await mkdir(join(seedDir, 'skills', 'hello'), { recursive: true })
        await writeFile(join(seedDir, 'skills', 'hello', 'SKILL.md'), '# Hello\n')
        await writeFile(join(seedDir, 'skills', 'hello', 'notes.md'), 'original\n')
        registerProvider(new FakeGithubProvider(seedDir, 'abc123'))
      },
    )
  })
})

describe('V0.4 lifecycle API — merge routing and envelopes', () => {
  it('routes merge / continue / abort through the lifecycle service', async () => {
    const calls: string[] = []
    const lifecycle: LifecycleService = {
      fork: async (name) => ({ name, action: 'forked' }),
      vendor: async (name) => ({ name, action: 'vendored' }),
      restore: async (name) => ({ name, action: 'restored', filesRestored: 4 }),
      merge: async (name, action) => {
        calls.push(`${name}:${action}`)
        return {
          name,
          action: action === 'continue' ? 'continued' : action === 'abort' ? 'aborted' : 'merged',
          filesMerged: 3,
        }
      },
    }
    await withLifecycleApp(lifecycle, async (app) => {
      const merged = await app.request('/api/skills/hello/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(merged.status).toBe(201)
      expect(((await merged.json()) as { result: { action: string } }).result.action).toBe('merged')

      const continued = await app.request('/api/skills/hello/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'continue' }),
      })
      expect(((await continued.json()) as { result: { action: string } }).result.action).toBe(
        'continued',
      )

      const aborted = await app.request('/api/skills/hello/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abort' }),
      })
      expect(((await aborted.json()) as { result: { action: string } }).result.action).toBe(
        'aborted',
      )

      // An unknown action falls back to the full merge.
      expect(calls).toEqual(['hello:merge', 'hello:continue', 'hello:abort'])
    })
  })

  it('maps lifecycle errors onto the M10.8 envelope (409 illegal transition)', async () => {
    const lifecycle: LifecycleService = {
      fork: async () => {
        throw new SkillboxError(
          ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
          'Skill "hello" cannot transition from vendored to forked',
          { context: { from: 'vendored', to: 'forked' } },
        )
      },
      vendor: async (name) => ({ name, action: 'vendored' }),
      restore: async (name) => ({ name, action: 'restored' }),
      merge: async (name, action) => ({ name, action: action === 'abort' ? 'aborted' : 'merged' }),
    }
    await withLifecycleApp(lifecycle, async (app) => {
      const response = await app.request('/api/skills/hello/fork', { method: 'POST' })
      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('LIFECYCLE_ILLEGAL_TRANSITION')
    })
  })
})

/** Builds a web app with an injected lifecycle service (routing tests). */
async function withLifecycleApp(
  lifecycle: LifecycleService,
  run: (app: Hono) => Promise<void>,
): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-lifecycle-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'skillbox-web-lifecycle-home-'))
  try {
    const services = createWebServices({ repositoryRoot: repository, homeRoot: home, lifecycle })
    const app = createWebApp({ services })
    await run(app)
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

describe('V0.4.2 rollback API', () => {
  it('lists backups and restores the runtime of a removed skill', async () => {
    await withApp(async (app, { home }) => {
      const created = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hello', description: 'demo' }),
      })
      expect(created.status).toBe(201)

      const removed = await app.request('/api/skills/hello', { method: 'DELETE' })
      expect(removed.status).toBe(200)
      await expect(
        readFile(join(home, 'library', 'local', 'hello', 'SKILL.md'), 'utf8'),
      ).rejects.toThrow()

      const list = await app.request('/api/rollbacks')
      expect(list.status).toBe(200)
      const body = (await list.json()) as {
        rollbacks: Array<{ id: string; operation: string; kind: string }>
      }
      const runtime = body.rollbacks.find(
        (record) => record.operation === 'remove' && record.kind === 'runtime',
      )
      expect(runtime).toBeDefined()

      const restored = await app.request(`/api/rollbacks/${runtime?.id ?? ''}/restore`, {
        method: 'POST',
      })
      expect(restored.status).toBe(201)
      await expect(
        readFile(join(home, 'library', 'local', 'hello', 'SKILL.md'), 'utf8'),
      ).resolves.toContain('# hello')
    })
  })
})

describe('V0.5 live event stream', () => {
  it('streams core events over SSE', async () => {
    await withApp(async (app) => {
      const server = createAdaptorServer({ fetch: app.fetch })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address() as { port: number }
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/events`)
        expect(response.status).toBe(200)
        const reader = response.body?.getReader()
        expect(reader).toBeDefined()
        const decoder = new TextDecoder()
        emitSkillboxEvent({ type: 'install:phase', phase: 'resolve', alias: 'hello' })
        const { value, done } = (await reader?.read()) ?? { value: undefined, done: true }
        expect(done).toBe(false)
        const text = decoder.decode(value)
        expect(text).toContain('install:phase')
        await reader?.cancel()
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })
})

/** Builds a web app with an injected Fleet service (routing tests). */
async function withFleetApp(fleet: FleetService, run: (app: Hono) => Promise<void>): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-fleet-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'skillbox-web-fleet-home-'))
  try {
    const services = createWebServices({ repositoryRoot: repository, homeRoot: home, fleet })
    const app = createWebApp({ services })
    await run(app)
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

describe('Fleet API', () => {
  it('GET /api/fleet/hosts lists an empty inventory when no fleet.yaml exists', async () => {
    const fleet = new FleetService({
      configPath: '/does/not/exist/fleet.yaml',
      ssh: new SshClient({ spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
    })
    await withFleetApp(fleet, async (app) => {
      const response = await app.request('/api/fleet/hosts')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { hosts: unknown[] }
      expect(body.hosts).toEqual([])
    })
  })

  it('POST /api/fleet/run reports a per-host failure without an HTTP error', async () => {
    const ssh = new SshClient({
      spawn: async (args) => {
        if (args[0] === '-V') {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        const destination = args.at(-2)
        return destination === '10.0.0.11'
          ? { exitCode: 0, stdout: 'ok\n', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'boom\n' }
      },
    })
    const fleet = new FleetService({ configPath: '/does/not/exist/fleet.yaml', ssh })
    await withFleetApp(fleet, async (app) => {
      const response = await app.request('/api/fleet/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'status',
          ssh: ['10.0.0.11', '10.0.0.12'],
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        result: { operation: string; results: Array<{ host: string; ok: boolean }> }
      }
      expect(body.result.operation).toBe('status')
      expect(body.result.results.find((entry) => entry.host === '10.0.0.11')?.ok).toBe(true)
      expect(body.result.results.find((entry) => entry.host === '10.0.0.12')?.ok).toBe(false)
    })
  })

  it('POST /api/fleet/run answers FLEET_NO_HOSTS_SELECTED (400) with no config and no selection', async () => {
    const fleet = new FleetService({
      configPath: '/does/not/exist/fleet.yaml',
      ssh: new SshClient({ spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
    })
    await withFleetApp(fleet, async (app) => {
      const response = await app.request('/api/fleet/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'install' }),
      })
      expect(response.status).toBe(404)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('FLEET_CONFIG_NOT_FOUND')
    })
  })

  it('POST /api/fleet/run rejects an invalid operation', async () => {
    const fleet = new FleetService({
      configPath: '/does/not/exist/fleet.yaml',
      ssh: new SshClient({ spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
    })
    await withFleetApp(fleet, async (app) => {
      const response = await app.request('/api/fleet/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'destroy' }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('POST /api/fleet/run rejects remove/enable/disable without a target', async () => {
    const fleet = new FleetService({
      configPath: '/does/not/exist/fleet.yaml',
      ssh: new SshClient({ spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
    })
    await withFleetApp(fleet, async (app) => {
      for (const operation of ['remove', 'enable', 'disable']) {
        const response = await app.request('/api/fleet/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation, ssh: ['10.0.0.11'] }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_REQUEST')
      }
    })
  })

  it('POST /api/fleet/run rejects enable/disable with a target missing the agent', async () => {
    const fleet = new FleetService({
      configPath: '/does/not/exist/fleet.yaml',
      ssh: new SshClient({ spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
    })
    await withFleetApp(fleet, async (app) => {
      const response = await app.request('/api/fleet/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'enable',
          ssh: ['10.0.0.11'],
          target: { name: 'incident-runbook' },
        }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_REQUEST')
    })
  })

  it('POST /api/fleet/run proxies remove/enable/disable to the built remote command', async () => {
    const commands: string[] = []
    const ssh = new SshClient({
      spawn: async (args) => {
        if (args[0] === '-V') {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        commands.push(args.at(-1) ?? '')
        return { exitCode: 0, stdout: 'ok\n', stderr: '' }
      },
    })
    const fleet = new FleetService({ configPath: '/does/not/exist/fleet.yaml', ssh })
    await withFleetApp(fleet, async (app) => {
      const remove = await app.request('/api/fleet/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'remove',
          ssh: ['10.0.0.11'],
          target: { name: 'legacy-deploy', deleteFiles: true },
        }),
      })
      expect(remove.status).toBe(200)

      const enable = await app.request('/api/fleet/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'enable',
          ssh: ['10.0.0.11'],
          target: { name: 'incident-runbook', agent: 'claude' },
        }),
      })
      expect(enable.status).toBe(200)
    })
    expect(commands).toEqual([
      "'skillbox' remove 'legacy-deploy' --delete-files",
      "'skillbox' enable 'incident-runbook' --agent 'claude'",
    ])
  })

  it('POST /api/fleet/run proxies sync through the multi-device engine, no target needed', async () => {
    const commands: string[] = []
    const ssh = new SshClient({
      spawn: async (args) => {
        if (args[0] === '-V') {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        commands.push(args.at(-1) ?? '')
        return { exitCode: 0, stdout: 'Sync complete\n', stderr: '' }
      },
    })
    const fleet = new FleetService({ configPath: '/does/not/exist/fleet.yaml', ssh })
    await withFleetApp(fleet, async (app) => {
      const response = await app.request('/api/fleet/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'sync', ssh: ['10.0.0.11'] }),
      })
      expect(response.status).toBe(200)
    })
    expect(commands).toEqual(["'skillbox' sync --multi-device"])
  })

  it('POST /api/fleet/hosts adds a host, creating fleet.yaml as needed', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'skillbox-web-fleet-hosts-'))
    try {
      const fleet = new FleetService({ configPath: join(configDir, 'fleet.yaml') })
      await withFleetApp(fleet, async (app) => {
        const response = await app.request('/api/fleet/hosts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'web-1', host: '10.0.0.11', tags: ['prod'] }),
        })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { host: unknown }
        expect(body.host).toEqual({ name: 'web-1', host: '10.0.0.11', tags: ['prod'] })
      })
      expect((await fleet.listHosts()).map((host) => host.name)).toEqual(['web-1'])
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('POST /api/fleet/hosts answers FLEET_HOST_EXISTS (409) for a duplicate name', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'skillbox-web-fleet-hosts-'))
    try {
      const fleet = new FleetService({ configPath: join(configDir, 'fleet.yaml') })
      await fleet.addHost({ name: 'web-1', host: '10.0.0.11' })
      await withFleetApp(fleet, async (app) => {
        const response = await app.request('/api/fleet/hosts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'web-1', host: '10.0.0.99' }),
        })
        expect(response.status).toBe(409)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('FLEET_HOST_EXISTS')
      })
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('PATCH /api/fleet/hosts/:name merges fields and can rename the host', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'skillbox-web-fleet-hosts-'))
    try {
      const fleet = new FleetService({ configPath: join(configDir, 'fleet.yaml') })
      await fleet.addHost({ name: 'web-1', host: '10.0.0.11', tags: ['prod'] })
      await withFleetApp(fleet, async (app) => {
        const response = await app.request('/api/fleet/hosts/web-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'web-1-renamed', host: '10.0.0.12' }),
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { host: unknown }
        expect(body.host).toEqual({ name: 'web-1-renamed', host: '10.0.0.12', tags: ['prod'] })
      })
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('PATCH /api/fleet/hosts/:name answers FLEET_HOST_NOT_FOUND (404) for an unknown host', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'skillbox-web-fleet-hosts-'))
    try {
      const fleet = new FleetService({ configPath: join(configDir, 'fleet.yaml') })
      await withFleetApp(fleet, async (app) => {
        const response = await app.request('/api/fleet/hosts/ghost', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: '10.0.0.12' }),
        })
        expect(response.status).toBe(404)
        const body = (await response.json()) as { error: { code: string } }
        expect(body.error.code).toBe('FLEET_HOST_NOT_FOUND')
      })
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('DELETE /api/fleet/hosts/:name removes the host', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'skillbox-web-fleet-hosts-'))
    try {
      const fleet = new FleetService({ configPath: join(configDir, 'fleet.yaml') })
      await fleet.addHost({ name: 'web-1', host: '10.0.0.11' })
      await withFleetApp(fleet, async (app) => {
        const response = await app.request('/api/fleet/hosts/web-1', { method: 'DELETE' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ removed: true })
      })
      expect(await fleet.listHosts()).toEqual([])
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })
})

/** A fake `RepositorySync`; individual methods throw unless overridden per test. */
function fakeRepositorySync(overrides: Partial<RepositorySync>): RepositorySync {
  const unimplemented = (name: string) => () => {
    throw new Error(`fakeRepositorySync.${name} was not stubbed for this test`)
  }
  return {
    status: overrides.status ?? unimplemented('status'),
    connectionState: overrides.connectionState ?? unimplemented('connectionState'),
    connect: overrides.connect ?? unimplemented('connect'),
    disconnect: overrides.disconnect ?? unimplemented('disconnect'),
    pull: overrides.pull ?? unimplemented('pull'),
    push: overrides.push ?? unimplemented('push'),
    sync: overrides.sync ?? unimplemented('sync'),
    listConflicts: overrides.listConflicts ?? unimplemented('listConflicts'),
    getConflict: overrides.getConflict ?? unimplemented('getConflict'),
    resolveConflicts: overrides.resolveConflicts ?? unimplemented('resolveConflicts'),
    restoreSnapshot: overrides.restoreSnapshot ?? unimplemented('restoreSnapshot'),
    listSnapshots:
      overrides.listSnapshots ??
      (async () => ({
        snapshots: [],
        expired: [],
      })),
  }
}

async function withSyncApp(sync: RepositorySync, run: (app: Hono) => Promise<void>): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'skillbox-web-sync-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'skillbox-web-sync-home-'))
  try {
    const services = createWebServices({ repositoryRoot: repository, homeRoot: home, sync })
    const app = createWebApp({ services })
    await run(app)
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

const conflictSession: ConflictSession = {
  version: 1,
  id: 'session-1',
  repositoryId: 'repo-1',
  baseRevision: 'base',
  localRevision: 'local',
  remoteRevision: 'remote',
  snapshotId: 'snapshot-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  conflicts: [
    {
      id: 'conflict-1',
      type: 'content',
      skillAlias: 'incident-runbook',
      allowedResolutions: ['local', 'remote', 'keep-both'],
      recommendedResolution: 'keep-both',
      destructive: false,
      local: { preview: 'local body' },
      remote: { preview: 'remote body' },
    },
  ],
}

describe('Sync API', () => {
  it('GET /api/sync/status reports idle with no open conflict session', async () => {
    const sync = fakeRepositorySync({
      listConflicts: async () => [],
      connectionState: async () => ({ state: 'connected', connected: true, login: 'octocat' }),
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync/status')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        sync: { kind: 'idle' },
        connection: { connected: true, login: 'octocat' },
      })
    })
  })

  it('GET /api/sync/status reports the open conflict session', async () => {
    const sync = fakeRepositorySync({
      listConflicts: async () => [conflictSession],
      connectionState: async () => ({ state: 'not-connected', connected: false }),
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync/status')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        sync: {
          kind: 'conflicts',
          sessionId: 'session-1',
          conflictCount: 1,
          snapshotId: 'snapshot-1',
        },
        connection: { connected: false },
      })
    })
  })

  it('POST /api/sync returns 200 with the merge summary on a clean sync', async () => {
    const outcome: SyncOutcome = {
      kind: 'completed',
      summary: { automaticallyMerged: 2, retriedPushes: 1, createdSnapshotId: 'snap-9' },
    }
    const sync = fakeRepositorySync({ sync: async () => outcome })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync', { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        sync: {
          kind: 'completed',
          automaticallyMerged: 2,
          retriedPushes: 1,
          snapshotId: 'snap-9',
        },
      })
    })
  })

  it('POST /api/sync returns 409 (not a thrown error) when sync needs a decision', async () => {
    const outcome: SyncOutcome = { kind: 'conflicts', session: conflictSession }
    const sync = fakeRepositorySync({ sync: async () => outcome })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync', { method: 'POST' })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        sync: {
          kind: 'conflicts',
          sessionId: 'session-1',
          conflictCount: 1,
          snapshotId: 'snapshot-1',
        },
      })
    })
  })

  it('POST /api/sync returns 423 when safely blocked', async () => {
    const outcome: SyncOutcome = {
      kind: 'blocked',
      reason: 'operation-locked',
      recovery: { retryable: true, message: 'Another sync is already running.' },
    }
    const sync = fakeRepositorySync({ sync: async () => outcome })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync', { method: 'POST' })
      expect(response.status).toBe(423)
      expect(await response.json()).toEqual({
        sync: {
          kind: 'blocked',
          reason: 'operation-locked',
          message: 'Another sync is already running.',
          retryable: true,
        },
      })
    })
  })

  it('GET /api/conflicts lists open sessions', async () => {
    const sync = fakeRepositorySync({ listConflicts: async () => [conflictSession] })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/conflicts')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { conflicts: Array<{ id: string }> }
      expect(body.conflicts).toHaveLength(1)
      expect(body.conflicts[0]?.id).toBe('session-1')
    })
  })

  it('GET /api/conflicts/:id maps a conflict with previews and a recommendation', async () => {
    const sync = fakeRepositorySync({
      getConflict: async (id) => {
        expect(id).toBe('session-1')
        return conflictSession
      },
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/conflicts/session-1')
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        conflict: { conflicts: Array<Record<string, unknown>> }
      }
      expect(body.conflict.conflicts[0]).toMatchObject({
        id: 'conflict-1',
        skillAlias: 'incident-runbook',
        localPreview: 'local body',
        remotePreview: 'remote body',
        recommendedResolution: 'keep-both',
        destructive: false,
      })
    })
  })

  /**
   * GAP §2.5: this API used to accept `delete`, `merged` and `restore` because Core
   * advertised them, and the engine closed the conflict without acting on them.  The
   * rendered choice list is now the same three the transaction implements, so a client
   * holding an older copy of the vocabulary gets a refusal instead of a false promise.
   */
  it.each(['delete', 'merged', 'restore'])(
    'POST /api/conflicts/:id/resolve refuses the retired %s choice',
    async (retired) => {
      let askedToResolve = 0
      const sync = fakeRepositorySync({
        resolveConflicts: async () => {
          askedToResolve += 1
          return { kind: 'completed', summary: { automaticallyMerged: 0, retriedPushes: 0 } }
        },
      })
      await withSyncApp(sync, async (app) => {
        const response = await app.request('/api/conflicts/session-1/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolutions: { 'conflict-1': retired } }),
        })
        expect(response.status).toBe(400)
        expect(askedToResolve).toBe(0)
        const body = (await response.json()) as { error: { code: string; message: string } }
        expect(body.error.code).toBe('INVALID_REQUEST')
        // The refusal renders the offer list, so it must not name a retired choice.
        expect(body.error.message).toContain('local/remote/keep-both')
        expect(body.error.message).not.toContain(retired)
      })
    },
  )

  it('POST /api/conflicts/:id/resolve rejects a missing/empty resolutions field', async () => {
    const sync = fakeRepositorySync({})
    await withSyncApp(sync, async (app) => {
      const missing = await app.request('/api/conflicts/session-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(missing.status).toBe(400)

      const empty = await app.request('/api/conflicts/session-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutions: {} }),
      })
      expect(empty.status).toBe(400)

      const invalidChoice = await app.request('/api/conflicts/session-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutions: { 'conflict-1': 'not-a-real-choice' } }),
      })
      expect(invalidChoice.status).toBe(400)
    })
  })

  it('POST /api/conflicts/:id/resolve applies choices and reports the resulting outcome', async () => {
    const outcome: SyncOutcome = {
      kind: 'completed',
      summary: { automaticallyMerged: 1, retriedPushes: 0 },
    }
    const sync = fakeRepositorySync({
      resolveConflicts: async (input) => {
        expect(input).toEqual({ sessionId: 'session-1', resolutions: { 'conflict-1': 'local' } })
        return outcome
      },
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/conflicts/session-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutions: { 'conflict-1': 'local' } }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        sync: { kind: 'completed', automaticallyMerged: 1, retriedPushes: 0 },
      })
    })
  })

  it('POST /api/sync/snapshots/:id/restore restores and confirms with a JSON body', async () => {
    let restoredId: string | undefined
    const sync = fakeRepositorySync({
      restoreSnapshot: async (id) => {
        restoredId = id
      },
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync/snapshots/snap-9/restore', { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ restored: true })
      expect(restoredId).toBe('snap-9')
    })
  })

  it('GET /api/sync/snapshots lists live checkpoints newest-first, then expired ones', async () => {
    const snapshot = (id: string, revision: string): SyncSnapshot => ({
      version: 1,
      id,
      repositoryKey: 'repo-key',
      repositoryIdentity: 'repo-key',
      createdAt: `2026-01-0${id === 'b' ? '2' : '1'}T00:00:00.000Z`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      ref: `refs/skillbox/snapshots/${id}`,
      revision,
      managedPaths: ['skillbox.yaml', 'skillbox.lock', 'skills'],
    })
    const sync = fakeRepositorySync({
      listSnapshots: async () => ({
        snapshots: [snapshot('b', 'abcdef1234567890'), snapshot('a', '9988776655443322')],
        expired: [snapshot('x', '1122334455667788')],
      }),
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync/snapshots')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        snapshots: [
          {
            id: 'b',
            createdAt: '2026-01-02T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
            revision: 'abcdef12',
            expired: false,
          },
          {
            id: 'a',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
            revision: '99887766',
            expired: false,
          },
          {
            id: 'x',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
            revision: '11223344',
            expired: true,
          },
        ],
      })
    })
  })

  it('a genuine sync failure (not connected) surfaces through the M10.8 error envelope', async () => {
    const sync = fakeRepositorySync({
      sync: async () => {
        throw new SkillboxError(ErrorCode.GITHUB_NOT_CONNECTED, 'Not connected to GitHub')
      },
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync', { method: 'POST' })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('GITHUB_NOT_CONNECTED')
    })
  })

  /**
   * GAP §4.6 follow-up — `SyncTransaction` reports a rollback that could not
   * finish twice: as `context.rollback` (data) and as a sentence appended to
   * `message` (prose), because `message` is the only field every surface prints.
   * The envelope has to hand the data over, so a UI can branch on
   * `restoreFailed` ("your files may not be restored") instead of parsing prose —
   * while the rest of `context` (command lines, credentials, stdout) stays inside
   * the process.
   */
  it('answers a sync failure whose rollback was incomplete with structured error.rollback', async () => {
    const SECRET = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const sync = fakeRepositorySync({
      sync: async () => {
        throw new SkillboxError(
          ErrorCode.GIT_PUSH_REJECTED,
          `git push failed; rollback is incomplete: the working tree was not restored from sync restore point "snap-1" (restore point "snap-1" could not be restored), so your files may still hold mid-transaction state`,
          {
            cause: new Error('non-fast-forward'),
            context: {
              command: `git push https://x-access-token:${SECRET}@github.com/acme/skills.git`,
              repositoryRoot: '/Users/dev/company-secret-repo',
              stdout: `remote: ${SECRET}`,
              rollback: {
                snapshotId: 'snap-1',
                restoreFailed: true,
                failures: [
                  {
                    step: 'restore',
                    target: 'snap-1',
                    message: 'restore point "snap-1" could not be restored',
                    blocking: true,
                  },
                  {
                    step: 'remove-worktree',
                    target: '/Users/dev/.skillbox/state/sync-trees/snap-1/base',
                    // Cleanup messages carry the raw git failure, which can hold
                    // a credential the envelope must never echo back.
                    message: `worktree removal failed: token=${SECRET}`,
                    blocking: false,
                  },
                ],
              },
            },
          },
        )
      },
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync', { method: 'POST' })
      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: Record<string, unknown> }

      expect(body.error.rollback).toEqual({
        snapshotId: 'snap-1',
        restoreFailed: true,
        failures: [
          {
            step: 'restore',
            target: 'snap-1',
            message: 'restore point "snap-1" could not be restored',
            blocking: true,
          },
          {
            step: 'remove-worktree',
            target: '/Users/dev/.skillbox/state/sync-trees/snap-1/base',
            message: 'worktree removal failed: token=[REDACTED]',
            blocking: false,
          },
        ],
      })
      /* Keep the prose: the CLI and the log lines print only `message`. */
      expect(body.error.message).toContain('rollback is incomplete')
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'recoverable', 'rollback'])
      const wire = JSON.stringify(body)
      expect(wire).not.toContain(SECRET)
      expect(wire).not.toContain('company-secret-repo')
      expect(wire).not.toContain('"command"')
      expect(wire).not.toContain('"stdout"')
    })
  })

  it('leaves a non-rollback envelope exactly as it was and never serializes context', async () => {
    const SECRET = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    const sync = fakeRepositorySync({
      sync: async () => {
        throw new SkillboxError(ErrorCode.GIT_AUTH_FAILED, 'git push failed: permission denied', {
          context: {
            command: `git push https://x-access-token:${SECRET}@github.com/acme/skills.git`,
            stderr: `fatal: Authentication failed for ${SECRET}`,
            accessToken: SECRET,
            nested: { password: SECRET },
            /* Near-misses must not be mistaken for a rollback report. */
            rollbackish: { restoreFailed: true },
          },
        })
      },
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync', { method: 'POST' })
      expect(response.status).toBe(401)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'GIT_AUTH_FAILED',
          message: 'git push failed: permission denied',
          recoverable: false,
        },
      })
      expect(text).not.toContain(SECRET)
    })
  })

  it('drops a rollback report it cannot read instead of exporting what it was handed', async () => {
    const SECRET = 'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
    for (const rollback of [
      'the working tree was not restored',
      { restoreFailed: true },
      { snapshotId: 'snap-1', restoreFailed: true, failures: 'restore failed' },
      { snapshotId: 'snap-1', restoreFailed: 'yes', failures: [] },
    ]) {
      const sync = fakeRepositorySync({
        sync: async () => {
          throw new SkillboxError(ErrorCode.GIT_PUSH_REJECTED, 'git push failed', {
            context: {
              command: `git push https://x-access-token:${SECRET}@github.com/a/b.git`,
              rollback,
            },
          })
        },
      })
      await withSyncApp(sync, async (app) => {
        const response = await app.request('/api/sync', { method: 'POST' })
        const text = await response.text()
        expect(JSON.parse(text)).toEqual({
          error: { code: 'GIT_PUSH_REJECTED', message: 'git push failed', recoverable: false },
        })
        expect(text).not.toContain(SECRET)
      })
    }
  })

  it('exports a rollback reported on a plain (non-Skillbox) error too', async () => {
    const sync = fakeRepositorySync({
      sync: async () => {
        const error = new Error('sync aborted') as Error & {
          context?: Record<string, unknown>
        }
        error.context = {
          rollback: {
            snapshotId: 'snap-9',
            restoreFailed: false,
            failures: [
              {
                step: 'remove-tree',
                target: '/Users/dev/.skillbox/state/sync-trees/snap-9',
                message: 'EBUSY: resource busy or locked',
                blocking: false,
              },
              // A step Core might add later is not whitelisted, so this entry is
              // dropped rather than exported with a shape the client cannot read.
              {
                step: 'rewrite-history',
                target: 'HEAD',
                message: 'nonsense',
                blocking: false,
              },
            ],
          },
        }
        throw error
      },
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync', { method: 'POST' })
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error: Record<string, unknown> }
      expect(body.error.code).toBe('INTERNAL_ERROR')
      expect(body.error.rollback).toEqual({
        snapshotId: 'snap-9',
        restoreFailed: false,
        failures: [
          {
            step: 'remove-tree',
            target: '/Users/dev/.skillbox/state/sync-trees/snap-9',
            message: 'EBUSY: resource busy or locked',
            blocking: false,
          },
        ],
      })
    })
  })

  it('POST /api/sync/disconnect removes only local credentials/metadata', async () => {
    let disconnects = 0
    const sync = fakeRepositorySync({
      disconnect: async () => {
        disconnects += 1
      },
    })
    await withSyncApp(sync, async (app) => {
      const response = await app.request('/api/sync/disconnect', { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ disconnected: true })
    })
    expect(disconnects).toBe(1)
  })
})
