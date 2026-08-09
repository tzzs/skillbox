import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { RuntimeConfig } from '@skillbox/core'
import type {
  AgentsResponse,
  HealthResponse,
  InstallResponse,
  OutdatedResponse,
  ReconcileResponse,
  RegistrySearchOptions,
  RegistrySearchResponse,
  SettingsResponse,
  SkillDiffResponse,
  SkillResponse,
  SkillsResponse,
  WebAppOptions,
} from './types.js'
import { toApiError, unknownRouteEnvelope, WebApiError } from './errors.js'
import { isHtmlNavigation, staticHandler } from './static.js'

/**
 * M10.6/M10.7 — the JSON API and the static frontend behind the Web Server.
 * All data flows through the Core services in `options.services`; the handlers
 * only shape requests/responses and translate Core errors into M10.8 envelopes.
 */
export function createWebApp(options: WebAppOptions): Hono {
  const { services } = options
  const info = options.info ?? { name: 'skillbox', version: '0.0.0' }
  const staticDir = options.staticDir

  const app = new Hono()

  app.onError((error, c) => {
    const api = toApiError(error)
    return c.json(api.body, toStatusCode(api.status))
  })

  /* ---- read-only API (M10.6) ---- */

  app.get('/api/health', (c) => {
    return c.json<HealthResponse>({
      status: 'ok',
      name: info.name,
      version: info.version,
      repository: services.repositoryRoot,
      home: services.homeRoot,
    })
  })

  app.get('/api/skills', async (c) => {
    const report = await services.status.status()
    return c.json<SkillsResponse>({ skills: report.skills })
  })

  app.get('/api/skills/:id/content', async (c) => {
    const id = c.req.param('id')
    const doc = await services.skills.readSkillMarkdown({ name: id })
    return c.json({ skill: { name: doc.name, path: doc.path, markdown: doc.markdown } })
  })

  /**
   * M19.5 — skill diff view. Read-only: managed skills compare the current
   * runtime against the latest upstream revision (one `Current vs Latest`
   * view); forked skills get the three Base/Local/Upstream views. Skills in
   * local/vendored mode have no upstream and answer `DIFF_UPSTREAM_UNAVAILABLE`.
   */
  app.get('/api/skills/:id/diff', async (c) => {
    const id = c.req.param('id')
    const diff = await services.diff.diffSkill(id)
    return c.json<SkillDiffResponse>({ diff })
  })

  app.get('/api/skills/:id', async (c) => {
    const id = c.req.param('id')
    const report = await services.status.status()
    const skill = report.skills.find((entry) => entry.name === id)
    if (skill === undefined) {
      throw new WebApiError(
        'SKILL_NOT_FOUND',
        `Skill "${id}" does not exist in this repository`,
        404,
      )
    }
    return c.json<SkillResponse>({ skill })
  })

  app.get('/api/agents', async (c) => {
    return c.json<AgentsResponse>({ agents: await services.registry.detectAll() })
  })

  app.get('/api/status', async (c) => {
    const report = await services.status.status()
    return c.json(report)
  })

  app.get('/api/settings', async (c) => {
    const settings = await services.config.load()
    return c.json<SettingsResponse>({ settings })
  })

  app.put('/api/settings', async (c) => {
    const body = await requireJsonBody(c)
    const patch = parseSettingsPatch(body)
    const current = await services.config.load()
    const merged = mergeSettings(current, patch)
    await services.config.save(merged)
    return c.json<SettingsResponse>({ settings: merged })
  })

  /* ---- mutating API (M10.7) ---- */

  app.post('/api/skills', async (c) => {
    const body = await requireJsonBody(c)
    const name = stringField(body, 'name')
    const description = stringField(body, 'description')
    const input: { name: string; description?: string } = { name }
    if (description !== undefined) {
      input.description = description
    }
    const created = await services.skills.createSkill(input)
    return c.json({ created }, 201)
  })

  app.put('/api/skills/:id/content', async (c) => {
    const id = c.req.param('id')
    const body = await requireJsonBody(c)
    const content = stringField(body, 'content')
    const saved = await services.skills.writeSkillMarkdown({ name: id, content })
    return c.json({ saved })
  })

  app.delete('/api/skills/:id', async (c) => {
    const id = c.req.param('id')
    const removed = await services.skills.removeSkill({ name: id })
    return c.json({ removed })
  })

  app.post('/api/skills/:id/enable', async (c) => {
    const id = c.req.param('id')
    const body = await requireJsonBody(c)
    const agent = stringField(body, 'agent')
    const assignment = await services.skills.enableSkill({ name: id, agent })
    return c.json({ assignment })
  })

  app.post('/api/skills/:id/disable', async (c) => {
    const id = c.req.param('id')
    const body = await requireJsonBody(c)
    const agent = stringField(body, 'agent')
    const assignment = await services.skills.disableSkill({ name: id, agent })
    return c.json({ assignment })
  })

  app.post('/api/reconcile', async (c) => {
    const reconcile = await services.skills.install()
    return c.json<ReconcileResponse>({ reconcile })
  })

  /* ---- V0.3 registry API (M14.7 Explore / M15 install / M16.3 updates) ---- */

  /**
   * M14.7 — aggregated registry search. `q` is optional so a bare browse
   * (Trending / Official / sort-only) works too; results flow through the
   * RegistrySearchService (agent 1 contract), decorated with provider,
   * security and install-state markers for the Explore UI.
   */
  app.get('/api/registry/search', async (c) => {
    const options: RegistrySearchOptions = {}
    const provider = c.req.query('provider')
    if (provider !== undefined && provider !== '') {
      options.provider = provider
    }
    const sort = c.req.query('sort')
    if (sort === 'popularity' || sort === 'recently-updated') {
      options.sort = sort
    }
    const trending = c.req.query('trending')
    if (trending === '1' || trending === 'true') {
      options.trending = true
    }
    const official = c.req.query('official')
    if (official === '1' || official === 'true') {
      options.official = true
    }
    const results = await services.search.search(c.req.query('q') ?? '', options)
    return c.json<RegistrySearchResponse>({ results })
  })

  /** M16.3 — installed-but-outdated skills with what changed since lock. */
  app.get('/api/registry/outdated', async (c) => {
    const outdated = await services.updates.outdated()
    return c.json<OutdatedResponse>({ outdated })
  })

  /**
   * M15 — remote install transaction. The body carries the source, the
   * target agents and the security policy (`safe` refuses high-risk skills,
   * `all` allows them after explicit user confirmation).
   */
  app.post('/api/registry/install', async (c) => {
    const body = await requireJsonBody(c)
    const source = stringField(body, 'source')
    const targetAgents = stringArrayField(body, 'targetAgents')
    const allowPolicy = allowPolicyField(body)
    const installed = await services.install.install({ source, targetAgents, allowPolicy })
    return c.json<InstallResponse>({ installed }, 201)
  })

  app.all('/api/*', (c) => c.json(unknownRouteEnvelope(), 404))

  /* ---- frontend static / SPA (M11.10) ---- */

  app.all('*', (c) => {
    if (staticDir === undefined) {
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        if (isHtmlNavigation(c)) {
          return c.json(
            {
              error: {
                code: 'WEB_ASSETS_MISSING',
                message:
                  'The frontend is not built. Run "pnpm build" in the repository or start the built CLI.',
                recoverable: true,
              },
            },
            503,
          )
        }
        return c.text('Not Found', 404)
      }
      return c.text('Method Not Allowed', 405)
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.text('Method Not Allowed', 405)
    }
    return staticHandler(staticDir)(c)
  })

  return app
}

/* ---- request helpers ---- */

interface JsonRequestLike {
  json(): Promise<unknown>
}

async function requireJsonBody(c: { req: JsonRequestLike }): Promise<Record<string, unknown>> {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    throw new WebApiError('INVALID_REQUEST', 'The request body must be valid JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WebApiError('INVALID_REQUEST', 'The request body must be a JSON object')
  }
  return payload as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebApiError(
      'INVALID_REQUEST',
      `Field "${field}" is required and must be a non-empty string`,
    )
  }
  return value
}

function stringArrayField(body: Record<string, unknown>, field: string): string[] {
  const value = body[field]
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  ) {
    throw new WebApiError(
      'INVALID_REQUEST',
      `Field "${field}" is required and must be a non-empty array of agent ids`,
    )
  }
  return value
}

function allowPolicyField(body: Record<string, unknown>): 'safe' | 'all' {
  const value = body['allowPolicy']
  if (value === 'safe' || value === 'all') {
    return value
  }
  throw new WebApiError('INVALID_REQUEST', 'Field "allowPolicy" must be either "safe" or "all"')
}

function toStatusCode(status: number): ContentfulStatusCode {
  if (status < 200 || status > 599) {
    return 500
  }
  return status as ContentfulStatusCode
}

/* ---- /api/settings helpers (GAP 1.2) ---- */

type LinkStrategy = 'auto' | 'symlink' | 'junction' | 'copy'

const LINK_STRATEGIES: readonly LinkStrategy[] = ['auto', 'symlink', 'junction', 'copy']

interface SettingsWebPatch {
  linkStrategy?: LinkStrategy
  web?: { port?: number; open?: boolean }
  agents?: Record<string, { path?: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates the editable subset of the Machine Config received by
 * `PUT /api/settings`. Only linkStrategy / web / agents are accepted; unknown
 * or malformed fields produce an `INVALID_REQUEST` envelope.
 */
function parseSettingsPatch(body: Record<string, unknown>): SettingsWebPatch {
  if (!isRecord(body.settings)) {
    throw new WebApiError('INVALID_REQUEST', 'Body field "settings" must be a JSON object')
  }
  const raw = body.settings
  const patch: SettingsWebPatch = {}

  if (raw.linkStrategy !== undefined) {
    const value = raw.linkStrategy
    if (typeof value !== 'string' || !LINK_STRATEGIES.includes(value as LinkStrategy)) {
      throw new WebApiError(
        'INVALID_REQUEST',
        `Field "linkStrategy" must be one of ${LINK_STRATEGIES.join(', ')}`,
      )
    }
    patch.linkStrategy = value as LinkStrategy
  }

  if (raw.web !== undefined) {
    if (!isRecord(raw.web)) {
      throw new WebApiError('INVALID_REQUEST', 'Field "web" must be an object')
    }
    const web: SettingsWebPatch['web'] = {}
    if (raw.web.port !== undefined) {
      if (
        typeof raw.web.port !== 'number' ||
        !Number.isInteger(raw.web.port) ||
        raw.web.port < 1 ||
        raw.web.port > 65535
      ) {
        throw new WebApiError(
          'INVALID_REQUEST',
          'Field "web.port" must be an integer between 1 and 65535',
        )
      }
      web.port = raw.web.port
    }
    if (raw.web.open !== undefined) {
      if (typeof raw.web.open !== 'boolean') {
        throw new WebApiError('INVALID_REQUEST', 'Field "web.open" must be a boolean')
      }
      web.open = raw.web.open
    }
    patch.web = web
  }

  if (raw.agents !== undefined) {
    if (!isRecord(raw.agents)) {
      throw new WebApiError('INVALID_REQUEST', 'Field "agents" must be an object')
    }
    const agents: NonNullable<SettingsWebPatch['agents']> = {}
    for (const [agentId, value] of Object.entries(raw.agents)) {
      if (value === undefined) {
        continue
      }
      if (!isRecord(value) || typeof value.path !== 'string') {
        throw new WebApiError(
          'INVALID_REQUEST',
          `Agent override "${agentId}" must be an object with a "path" string (empty removes it)`,
        )
      }
      agents[agentId] = { path: value.path }
    }
    patch.agents = agents
  }

  return patch
}

/**
 * Deep-merges a validated settings patch into the persisted Machine Config.
 * Only the fields the client sent are touched, so untouched settings (e.g. a
 * manually configured `repository`) survive an update.
 */
function mergeSettings(current: RuntimeConfig, patch: SettingsWebPatch): RuntimeConfig {
  const next: RuntimeConfig = { ...current }
  if (patch.linkStrategy !== undefined) {
    next.linkStrategy = patch.linkStrategy
  }
  if (patch.web !== undefined) {
    const mergedWeb: NonNullable<RuntimeConfig['web']> = { ...current.web }
    if (patch.web.port !== undefined) {
      mergedWeb.port = patch.web.port
    }
    if (patch.web.open !== undefined) {
      mergedWeb.open = patch.web.open
    }
    next.web = mergedWeb
  }
  if (patch.agents !== undefined) {
    const mergedAgents: NonNullable<RuntimeConfig['agents']> = { ...current.agents }
    let touched = false
    for (const [agentId, override] of Object.entries(patch.agents)) {
      const existing = mergedAgents[agentId]
      const entry: { path?: string; executable?: string } = {}
      if (existing !== undefined) {
        if (existing.path !== undefined) entry.path = existing.path
        else if (existing.executable !== undefined) entry.executable = existing.executable
      }
      touched = true
      if (!(typeof override.path === 'string' && override.path.length > 0)) {
        delete mergedAgents[agentId]
        continue
      }
      entry.path = override.path
      delete entry.executable
      mergedAgents[agentId] = entry
    }
    if (touched) {
      if (Object.keys(mergedAgents).length === 0) {
        delete next.agents
      } else {
        next.agents = mergedAgents
      }
    }
  }
  return next
}
