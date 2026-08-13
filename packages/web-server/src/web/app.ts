import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ConflictSession, RuntimeConfig, SyncConflict, SyncOutcome } from '@skillbox/core'
import type {
  AgentsResponse,
  ConflictResponse,
  ConflictsResponse,
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
  SyncResponse,
  SyncStatusResponse,
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

  app.get('/api/sync/status', async (c) => {
    const [session] = await services.sync.listConflicts()
    if (session !== undefined) {
      return c.json<SyncStatusResponse>({
        sync: {
          kind: 'conflicts',
          sessionId: session.id,
          conflictCount: session.conflicts.length,
          snapshotId: session.snapshotId,
        },
      })
    }
    await services.sync.status()
    return c.json<SyncStatusResponse>({ sync: { kind: 'idle' } })
  })

  app.post('/api/sync', async (c) => {
    const outcome = await services.sync.sync()
    return c.json<SyncResponse>(
      { sync: presentSyncOutcome(outcome) },
      outcome.kind === 'completed' ? 200 : outcome.kind === 'conflicts' ? 409 : 423,
    )
  })

  app.get('/api/conflicts', async (c) =>
    c.json<ConflictsResponse>({
      conflicts: (await services.sync.listConflicts()).map(presentSession),
    }),
  )
  app.get('/api/conflicts/:id', async (c) => {
    const session = await services.sync.getConflict(c.req.param('id'))
    return c.json<ConflictResponse>({ conflict: presentSession(session) })
  })
  app.post('/api/conflicts/:id/resolve', async (c) => {
    const sessionId = c.req.param('id')
    const outcome = await services.sync.resolveConflicts({
      sessionId,
      resolutions: resolutionsField(await requireJsonBody(c)),
    })
    return c.json<SyncResponse>(
      { sync: presentSyncOutcome(outcome) },
      outcome.kind === 'completed' ? 200 : outcome.kind === 'conflicts' ? 409 : 423,
    )
  })
  app.post('/api/sync/snapshots/:id/restore', async (c) => {
    await services.sync.restoreSnapshot(c.req.param('id'))
    return c.json({ restored: true })
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

  /* ---- lifecycle mutations: Core owns every transaction ---- */

  app.post('/api/skills/:id/fork', async (c) => {
    return c.json({ forked: await services.lifecycle.fork(c.req.param('id')) })
  })
  app.post('/api/skills/:id/vendor', async (c) => {
    const body = await optionalJsonBody(c)
    const keepProvenance = booleanField(body, 'keepProvenance')
    const removeBaseSnapshot = booleanField(body, 'removeBaseSnapshot')
    return c.json({
      vendored: await services.lifecycle.vendor(c.req.param('id'), {
        ...(keepProvenance === undefined ? {} : { keepProvenance }),
        ...(removeBaseSnapshot === undefined ? {} : { removeBaseSnapshot }),
      }),
    })
  })
  app.post('/api/skills/:id/restore', async (c) =>
    c.json({ restored: await services.lifecycle.restore(c.req.param('id')) }),
  )
  app.post('/api/skills/:id/merge', async (c) =>
    c.json({ merge: await services.lifecycle.merge(c.req.param('id')) }),
  )
  app.post('/api/skills/:id/merge/continue', async (c) =>
    c.json({ merge: await services.lifecycle.continueMerge(c.req.param('id')) }),
  )
  app.post('/api/skills/:id/merge/abort', async (c) =>
    c.json({ merge: await services.lifecycle.abortMerge(c.req.param('id')) }),
  )
  app.post('/api/operations/rollback', async (c) => {
    const body = await optionalJsonBody(c)
    const operationId = optionalStringField(body, 'operationId')
    return c.json({ rollback: await services.operations.rollback(operationId) })
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

async function optionalJsonBody(c: {
  req: JsonRequestLike & { raw: Request }
}): Promise<Record<string, unknown>> {
  // Hono's synthetic no-body POST requests omit Content-Length; only that
  // case is optional. A non-empty malformed body must retain the normal 400.
  const length = c.req.raw.headers.get('content-length')
  const contentType = c.req.raw.headers.get('content-type')
  if ((length === null || length === '0') && contentType === null) return {}
  return requireJsonBody(c)
}

function optionalStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebApiError('INVALID_REQUEST', `Field "${field}" must be a non-empty string`)
  }
  return value
}

function booleanField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new WebApiError('INVALID_REQUEST', `Field "${field}" must be a boolean`)
  }
  return value
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

function resolutionsField(
  body: Record<string, unknown>,
): Record<string, 'local' | 'remote' | 'keep-both' | 'merged' | 'delete' | 'restore'> {
  const value = body.resolutions
  const allowed = new Set(['local', 'remote', 'keep-both', 'merged', 'delete', 'restore'])
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !Object.values(value).every((entry) => typeof entry === 'string' && allowed.has(entry))
  )
    throw new WebApiError(
      'INVALID_REQUEST',
      'Field "resolutions" must contain one valid decision per conflict',
    )
  return value as Record<string, 'local' | 'remote' | 'keep-both' | 'merged' | 'delete' | 'restore'>
}

function presentSyncOutcome(outcome: SyncOutcome): import('./types.js').SyncOutcomeDto {
  if (outcome.kind === 'completed')
    return {
      kind: 'completed',
      automaticallyMerged: outcome.summary.automaticallyMerged,
      retriedPushes: outcome.summary.retriedPushes,
      ...(outcome.summary.createdSnapshotId === undefined
        ? {}
        : { snapshotId: outcome.summary.createdSnapshotId }),
    }
  if (outcome.kind === 'conflicts')
    return {
      kind: 'conflicts',
      sessionId: outcome.session.id,
      conflictCount: outcome.session.conflicts.length,
      snapshotId: outcome.session.snapshotId,
    }
  return {
    kind: 'blocked',
    reason: outcome.reason,
    message: outcome.recovery.message,
    retryable: outcome.recovery.retryable,
    ...(outcome.recovery.snapshotId === undefined
      ? {}
      : { snapshotId: outcome.recovery.snapshotId }),
  }
}
function presentSession(session: ConflictSession): import('./types.js').ConflictSessionDto {
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    snapshotId: session.snapshotId,
    conflicts: session.conflicts.map(presentConflict),
  }
}
function presentConflict(conflict: SyncConflict): import('./types.js').SyncConflictDto {
  return {
    id: conflict.id,
    type: conflict.type,
    ...(conflict.skillAlias === undefined ? {} : { skillAlias: conflict.skillAlias }),
    ...(conflict.path === undefined ? {} : { path: conflict.path }),
    ...(conflict.field === undefined ? {} : { field: conflict.field }),
    ...(conflict.base?.preview === undefined ? {} : { basePreview: conflict.base.preview }),
    ...(conflict.local?.preview === undefined ? {} : { localPreview: conflict.local.preview }),
    ...(conflict.remote?.preview === undefined ? {} : { remotePreview: conflict.remote.preview }),
    allowedResolutions: conflict.allowedResolutions,
    ...(conflict.recommendedResolution === undefined
      ? {}
      : { recommendedResolution: conflict.recommendedResolution }),
    destructive: conflict.destructive,
  }
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
  web?: { host?: string; port?: number; open?: boolean }
  agents?: Record<string, { path?: string; skillDirectories?: string[] }>
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
    if (raw.web.host !== undefined) {
      if (typeof raw.web.host !== 'string' || raw.web.host.trim().length === 0) {
        throw new WebApiError('INVALID_REQUEST', 'Field "web.host" must be a non-empty string')
      }
      web.host = raw.web.host.trim()
    }
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
      if (!isRecord(value)) {
        throw new WebApiError('INVALID_REQUEST', `Agent override "${agentId}" must be an object`)
      }
      const override: NonNullable<SettingsWebPatch['agents']>[string] = {}
      if (value.path !== undefined) {
        if (typeof value.path !== 'string') {
          throw new WebApiError(
            'INVALID_REQUEST',
            `Agent override "${agentId}" field "path" must be a string (empty removes it)`,
          )
        }
        override.path = value.path
      }
      if (value.skillDirectories !== undefined) {
        if (
          !Array.isArray(value.skillDirectories) ||
          !value.skillDirectories.every(
            (directory): directory is string =>
              typeof directory === 'string' && directory.trim().length > 0,
          )
        ) {
          throw new WebApiError(
            'INVALID_REQUEST',
            `Agent override "${agentId}" field "skillDirectories" must be an array of non-empty strings`,
          )
        }
        override.skillDirectories = value.skillDirectories.map((directory) => directory.trim())
      }
      if (override.path === undefined && override.skillDirectories === undefined) {
        throw new WebApiError(
          'INVALID_REQUEST',
          `Agent override "${agentId}" must include "path" and/or "skillDirectories"`,
        )
      }
      agents[agentId] = override
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
    if (patch.web.host !== undefined) {
      mergedWeb.host = patch.web.host
    }
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
      const entry: { path?: string; skillDirectories?: string[]; executable?: string } = {}
      if (existing !== undefined) {
        if (existing.path !== undefined) entry.path = existing.path
        if (existing.skillDirectories !== undefined)
          entry.skillDirectories = existing.skillDirectories
        if (existing.executable !== undefined) entry.executable = existing.executable
      }
      touched = true
      if (override.path !== undefined) {
        if (override.path.length === 0) delete entry.path
        else entry.path = override.path
        // Preserve the existing path-override contract: setting or clearing a
        // path takes ownership of that legacy field rather than retaining a
        // stale executable-only override.
        delete entry.executable
      }
      if (override.skillDirectories !== undefined) {
        if (override.skillDirectories.length === 0) delete entry.skillDirectories
        else entry.skillDirectories = override.skillDirectories
      }
      if (
        entry.path === undefined &&
        entry.skillDirectories === undefined &&
        entry.executable === undefined
      ) {
        delete mergedAgents[agentId]
        continue
      }
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
