import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  BackupService,
  defaultEventBus,
  parseAdHocHost,
  withRuntimeLock,
  type ConflictResolution,
  type ConflictSession,
  type FleetHostSelector,
  type FleetOperationName,
  type FleetRunOptions,
  type FleetSkillTarget,
  type RuntimeConfig,
  type RollbackResult,
  type SyncConflict,
  type SyncOutcome,
} from '@skillbox/core'
import type {
  AgentsResponse,
  ConflictResponse,
  ConflictsResponse,
  FleetHostCreateRequest,
  FleetHostPatchRequest,
  FleetHostRemoveResponse,
  FleetHostResponse,
  FleetHostsResponse,
  FleetRunResponse,
  HealthResponse,
  InstallResponse,
  LifecycleOperationResult,
  OutdatedResponse,
  ReconcileResponse,
  RegistrySearchOptions,
  RegistrySearchResponse,
  RollbackListResponse,
  RollbackRestoreResponse,
  SettingsResponse,
  SkillDiffResponse,
  SkillResponse,
  SkillsResponse,
  SyncConnectionDto,
  SyncDisconnectResponse,
  SyncResponse,
  SyncStatusResponse,
  WebAppOptions,
  WebServices,
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
    return mutation(services, async () => {
      const body = await requireJsonBody(c)
      const patch = parseSettingsPatch(body)
      const current = await services.config.load()
      const merged = mergeSettings(current, patch)
      await services.config.save(merged)
      return c.json<SettingsResponse>({ settings: merged })
    })
  })

  /* ---- mutating API (M10.7) ---- */

  app.post('/api/skills', async (c) => {
    return mutation(services, async () => {
      const body = await requireJsonBody(c)
      const name = stringField(body, 'name')
      const description = optionalStringField(body, 'description')
      const input: { name: string; description?: string } = { name }
      if (description !== undefined) {
        input.description = description
      }
      const created = await services.skills.createSkill(input)
      return c.json({ created }, 201)
    })
  })

  app.put('/api/skills/:id/content', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const body = await requireJsonBody(c)
      const content = stringField(body, 'content')
      const saved = await services.skills.writeSkillMarkdown({ name: id, content })
      return c.json({ saved })
    })
  })

  app.delete('/api/skills/:id', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const removed = await services.skills.removeSkill({ name: id })
      return c.json({ removed })
    })
  })

  app.post('/api/skills/:id/enable', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const body = await requireJsonBody(c)
      const agent = stringField(body, 'agent')
      const assignment = await services.skills.enableSkill({ name: id, agent })
      return c.json({ assignment })
    })
  })

  app.post('/api/skills/:id/disable', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const body = await requireJsonBody(c)
      const agent = stringField(body, 'agent')
      const assignment = await services.skills.disableSkill({ name: id, agent })
      return c.json({ assignment })
    })
  })

  app.post('/api/reconcile', async (c) => {
    return mutation(services, async () => {
      const reconcile = await services.skills.install()
      return c.json<ReconcileResponse>({ reconcile })
    })
  })

  /* ---- V0.4 lifecycle API (M17 fork/vendor/restore, M20 merge) ---- */

  /**
   * M17.1 — Fork: Managed → Forked. The runtime is copied into the
   * repository (`skills/<name>`), the mode flips to `forked` and the base
   * revision is recorded so the 3-way merge has a base.
   */
  app.post('/api/skills/:id/fork', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const result = await services.lifecycle.fork(id)
      return c.json<{ result: LifecycleOperationResult }>({ result }, 201)
    })
  })

  /**
   * M18 — Vendor: Managed/Forked → Vendored. The content is frozen in the
   * repository and all upstream tracking is dropped (terminal state).
   */
  app.post('/api/skills/:id/vendor', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const result = await services.lifecycle.vendor(id)
      return c.json<{ result: LifecycleOperationResult }>({ result }, 201)
    })
  })

  /**
   * M17.3 — Restore Upstream: re-materializes the pinned revision of a
   * modified managed skill so the runtime matches the lockfile integrity
   * again. The pre-restore content is kept in a recovery snapshot.
   */
  app.post('/api/skills/:id/restore', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const result = await services.lifecycle.restore(id)
      return c.json<{ result: LifecycleOperationResult }>({ result }, 201)
    })
  })

  /**
   * M20 — 3-way merge (default), or `--continue` / `--abort` of an in-flight
   * merge via `{ "action": "continue" | "abort" }`.
   */
  app.post('/api/skills/:id/merge', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const body = await requireJsonBody(c)
      const action =
        body['action'] === 'continue' || body['action'] === 'abort' ? body['action'] : 'merge'
      const result = await services.lifecycle.merge(id, action)
      return c.json<{ result: LifecycleOperationResult }>({ result }, 201)
    })
  })

  /* ---- live event stream (roadmap 5.1 / GAP §4.4) ---- */

  /**
   * Server-Sent Events: streams every Core event (`install:phase`, ...
   * `reconcile:completed`) from the process-wide defaultEventBus to the UI.
   * The stream stays open until the client disconnects.
   */
  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const subscription = defaultEventBus.on((event) => {
          try {
            void stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
          } catch {
            // A client that vanished mid-write must not break the bus.
          }
        })
        stream.onAbort(() => {
          subscription.unsubscribe()
          resolve()
        })
      })
    })
  })

  /* ---- V0.4.2 rollback API (roadmap 2.4) ---- */

  /** Lists the recoverable backups recorded by mutating operations. */
  app.get('/api/rollbacks', async (c) => {
    const rollbacks = await new BackupService({ homeRoot: services.homeRoot }).list()
    return c.json<RollbackListResponse>({ rollbacks })
  })

  /** Restores one backup (cross-repo / incomplete records are refused). */
  app.post('/api/rollbacks/:id/restore', async (c) => {
    return mutation(services, async () => {
      const id = c.req.param('id')
      const rollback: RollbackResult = await new BackupService({
        homeRoot: services.homeRoot,
      }).rollback(id, { repositoryRoot: services.repositoryRoot })
      return c.json<RollbackRestoreResponse>({ rollback }, 201)
    })
  })

  /* ---- Fleet API: multi-host SSH orchestration ---- */

  /** Lists the hosts configured in `.skillbox/fleet.yaml` (`[]` if the file is absent). */
  app.get('/api/fleet/hosts', async (c) => {
    const hosts = await services.fleet.listHosts()
    return c.json<FleetHostsResponse>({ hosts })
  })

  /** Adds a host to `.skillbox/fleet.yaml`, creating the file if needed. */
  app.post('/api/fleet/hosts', async (c) => {
    return mutation(services, async () => {
      const body = await requireJsonBody(c)
      const host = await services.fleet.addHost(parseFleetHostCreateBody(body))
      return c.json<FleetHostResponse>({ host }, 201)
    })
  })

  /** Merges the given fields into the named host; `name` renames it. */
  app.patch('/api/fleet/hosts/:name', async (c) => {
    return mutation(services, async () => {
      const name = c.req.param('name')
      const body = await requireJsonBody(c)
      const host = await services.fleet.updateHost(name, parseFleetHostPatchBody(body))
      return c.json<FleetHostResponse>({ host })
    })
  })

  /** Removes a host from `.skillbox/fleet.yaml`. */
  app.delete('/api/fleet/hosts/:name', async (c) => {
    return mutation(services, async () => {
      const name = c.req.param('name')
      await services.fleet.removeHost(name)
      return c.json<FleetHostRemoveResponse>({ removed: true })
    })
  })

  /**
   * Runs `install` / `update` / `status` / `remove` / `enable` / `disable`
   * across the selected hosts over SSH. `remove`/`enable`/`disable` (and
   * optionally `update`) target one skill via `body.target`. A per-host
   * failure is reported inside `result.results` (200), never as an HTTP
   * error — only a structural problem (bad selection, missing target, no
   * local `ssh`) throws. No local runtime state is touched, so this route
   * skips the mutation lock.
   */
  app.post('/api/fleet/run', async (c) => {
    const body = await requireJsonBody(c)
    const { operation, selector, options } = parseFleetRunBody(body)
    const result = await services.fleet.run(operation, selector, options)
    return c.json<FleetRunResponse>({ result })
  })

  /* ---- Multi-device sync API (RepositorySync) ----
   * `connect`/`disconnect` stay CLI-only (`skillbox connect`): the GitHub
   * device-flow handshake can take minutes and doesn't fit a single
   * request/response cycle. Once a device is connected, these routes cover
   * day-to-day sync + conflict resolution. A `conflicts` or `blocked`
   * outcome is a normal, expected result of `sync` — not a thrown error —
   * so it's reported as 409/423 with a JSON body, never the M10.8 error
   * envelope; only a genuine failure (not connected, git unavailable, ...)
   * throws through `app.onError`.
   */

  /** The open conflict session, if any — the resting state between syncs. */
  app.get('/api/sync/status', async (c) => {
    const [[session], snapshot] = await Promise.all([
      services.sync.listConflicts(),
      services.sync.connectionState(),
    ])
    const connection: SyncConnectionDto = {
      connected: snapshot.connected,
      ...(snapshot.login === undefined ? {} : { login: snapshot.login }),
      ...(snapshot.repository === undefined ? {} : { repository: snapshot.repository }),
    }
    if (session !== undefined) {
      return c.json<SyncStatusResponse>({
        sync: {
          kind: 'conflicts',
          sessionId: session.id,
          conflictCount: session.conflicts.length,
          snapshotId: session.snapshotId,
        },
        connection,
      })
    }
    return c.json<SyncStatusResponse>({ sync: { kind: 'idle' }, connection })
  })

  app.post('/api/sync', async (c) => {
    const outcome = await services.sync.sync()
    return c.json<SyncResponse>(
      { sync: presentSyncOutcome(outcome) },
      toStatusCode(syncOutcomeStatus(outcome)),
    )
  })

  app.get('/api/conflicts', async (c) => {
    const sessions = await services.sync.listConflicts()
    return c.json<ConflictsResponse>({ conflicts: sessions.map(presentConflictSession) })
  })

  app.get('/api/conflicts/:id', async (c) => {
    const session = await services.sync.getConflict(c.req.param('id'))
    return c.json<ConflictResponse>({ conflict: presentConflictSession(session) })
  })

  app.post('/api/conflicts/:id/resolve', async (c) => {
    const body = await requireJsonBody(c)
    const resolutions = requireResolutionsField(body)
    const outcome = await services.sync.resolveConflicts({
      sessionId: c.req.param('id'),
      resolutions,
    })
    return c.json<SyncResponse>(
      { sync: presentSyncOutcome(outcome) },
      toStatusCode(syncOutcomeStatus(outcome)),
    )
  })

  app.post('/api/sync/snapshots/:id/restore', async (c) => {
    await services.sync.restoreSnapshot(c.req.param('id'))
    return c.json({ restored: true })
  })

  /** Removes only local GitHub credentials/connection metadata — never touches the repository. */
  app.post('/api/sync/disconnect', async (c) => {
    await services.sync.disconnect()
    return c.json<SyncDisconnectResponse>({ disconnected: true })
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
    return mutation(services, async () => {
      const body = await requireJsonBody(c)
      const source = stringField(body, 'source')
      const targetAgents = stringArrayField(body, 'targetAgents')
      const allowPolicy = allowPolicyField(body)
      const installed = await services.install.install({ source, targetAgents, allowPolicy })
      return c.json<InstallResponse>({ installed }, 201)
    })
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

/**
 * Runs a mutating web handler under the cross-process runtime lock
 * (`~/.skillbox/state/locks/mutation.lock`, roadmap 5.1) so concurrent CLI /
 * Web processes cannot corrupt the Manifest / Lockfile / library / merge
 * state. The lock is always released (also on errors); stale locks from
 * crashed processes are broken automatically.
 */
async function mutation<T>(services: WebServices, action: () => Promise<T>): Promise<T> {
  return withRuntimeLock('mutation', action, { homeRoot: services.homeRoot })
}

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

/* ---- /api/fleet/run body (multi-host SSH orchestration) ---- */

const FLEET_OPERATIONS: ReadonlySet<string> = new Set([
  'install',
  'update',
  'status',
  'remove',
  'enable',
  'disable',
  'sync',
])

const FLEET_TARGET_REQUIRED_OPERATIONS: ReadonlySet<string> = new Set([
  'remove',
  'enable',
  'disable',
])

/** Parses `body.target`, required for remove/enable/disable, optional (single-skill) for update. */
function parseFleetTarget(
  body: Record<string, unknown>,
  operation: string,
): FleetSkillTarget | undefined {
  const raw = body['target']
  if (raw === undefined) {
    if (FLEET_TARGET_REQUIRED_OPERATIONS.has(operation)) {
      throw new WebApiError('INVALID_REQUEST', `Field "target" is required for "${operation}"`)
    }
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new WebApiError('INVALID_REQUEST', 'Field "target" must be an object')
  }
  const { name, agent, deleteFiles, yes } = raw as Record<string, unknown>
  if (typeof name !== 'string' || name.length === 0) {
    throw new WebApiError('INVALID_REQUEST', 'Field "target.name" must be a non-empty string')
  }
  const target: FleetSkillTarget = { name }
  if ((operation === 'enable' || operation === 'disable') && typeof agent !== 'string') {
    throw new WebApiError('INVALID_REQUEST', `Field "target.agent" is required for "${operation}"`)
  }
  if (agent !== undefined) {
    if (typeof agent !== 'string') {
      throw new WebApiError('INVALID_REQUEST', 'Field "target.agent" must be a string')
    }
    target.agent = agent
  }
  if (deleteFiles !== undefined) {
    if (typeof deleteFiles !== 'boolean') {
      throw new WebApiError('INVALID_REQUEST', 'Field "target.deleteFiles" must be a boolean')
    }
    target.deleteFiles = deleteFiles
  }
  if (yes !== undefined) {
    if (typeof yes !== 'boolean') {
      throw new WebApiError('INVALID_REQUEST', 'Field "target.yes" must be a boolean')
    }
    target.yes = yes
  }
  return target
}

/** Like {@link stringArrayField}, but the field is optional and may be `[]`. */
function optionalStringArrayField(
  body: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = body[field]
  if (value === undefined) {
    return undefined
  }
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new WebApiError('INVALID_REQUEST', `Field "${field}" must be an array of strings`)
  }
  return value
}

function parseFleetRunBody(body: Record<string, unknown>): {
  operation: FleetOperationName
  selector: FleetHostSelector
  options: FleetRunOptions
} {
  const operation = body['operation']
  if (typeof operation !== 'string' || !FLEET_OPERATIONS.has(operation)) {
    throw new WebApiError(
      'INVALID_REQUEST',
      'Field "operation" must be install/update/status/remove/enable/disable/sync',
    )
  }

  const hosts = optionalStringArrayField(body, 'hosts')
  const tags = optionalStringArrayField(body, 'tags')
  const ssh = optionalStringArrayField(body, 'ssh')
  const selector: FleetHostSelector = {}
  if (hosts !== undefined && hosts.length > 0) {
    selector.hostNames = hosts
  }
  if (tags !== undefined && tags.length > 0) {
    selector.tags = tags
  }
  if (ssh !== undefined && ssh.length > 0) {
    selector.adHoc = ssh.map(parseAdHocHost)
  }

  const options: FleetRunOptions = {}
  const concurrency = body['concurrency']
  if (concurrency !== undefined) {
    if (typeof concurrency !== 'number' || !Number.isFinite(concurrency) || concurrency <= 0) {
      throw new WebApiError('INVALID_REQUEST', 'Field "concurrency" must be a positive number')
    }
    options.concurrency = concurrency
  }
  const dryRun = body['dryRun']
  if (dryRun !== undefined) {
    if (typeof dryRun !== 'boolean') {
      throw new WebApiError('INVALID_REQUEST', 'Field "dryRun" must be a boolean')
    }
    options.dryRun = dryRun
  }
  const target = parseFleetTarget(body, operation)
  if (target !== undefined) {
    options.target = target
  }

  return { operation: operation as FleetOperationName, selector, options }
}

/* ---- /api/fleet/hosts body (fleet.yaml CRUD) ---- */

function optionalStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebApiError('INVALID_REQUEST', `Field "${field}" must be a non-empty string`)
  }
  return value
}

function optionalPositiveIntField(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = body[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new WebApiError('INVALID_REQUEST', `Field "${field}" must be a positive integer`)
  }
  return value
}

/** Shared optional fields (`user`/`port`/`identityFile`/`remotePath`/`skillboxBin`/`tags`) across create and patch. */
function parseFleetHostOptionalFields(
  body: Record<string, unknown>,
): Omit<FleetHostCreateRequest, 'name' | 'host'> {
  const fields: Omit<FleetHostCreateRequest, 'name' | 'host'> = {}
  const user = optionalStringField(body, 'user')
  if (user !== undefined) fields.user = user
  const port = optionalPositiveIntField(body, 'port')
  if (port !== undefined) fields.port = port
  const identityFile = optionalStringField(body, 'identityFile')
  if (identityFile !== undefined) fields.identityFile = identityFile
  const remotePath = optionalStringField(body, 'remotePath')
  if (remotePath !== undefined) fields.remotePath = remotePath
  const skillboxBin = optionalStringField(body, 'skillboxBin')
  if (skillboxBin !== undefined) fields.skillboxBin = skillboxBin
  const tags = optionalStringArrayField(body, 'tags')
  if (tags !== undefined) fields.tags = tags
  return fields
}

function parseFleetHostCreateBody(body: Record<string, unknown>): FleetHostCreateRequest {
  return {
    name: stringField(body, 'name'),
    host: stringField(body, 'host'),
    ...parseFleetHostOptionalFields(body),
  }
}

function parseFleetHostPatchBody(body: Record<string, unknown>): FleetHostPatchRequest {
  const patch: FleetHostPatchRequest = { ...parseFleetHostOptionalFields(body) }
  const name = optionalStringField(body, 'name')
  if (name !== undefined) patch.name = name
  const host = optionalStringField(body, 'host')
  if (host !== undefined) patch.host = host
  return patch
}

/* ---- /api/sync + /api/conflicts helpers (RepositorySync) ---- */

const CONFLICT_RESOLUTIONS: ReadonlySet<string> = new Set([
  'local',
  'remote',
  'keep-both',
  'merged',
  'delete',
  'restore',
])

/** Validates `body.resolutions`: a non-empty map of conflict id → resolution choice. */
function requireResolutionsField(
  body: Record<string, unknown>,
): Record<string, ConflictResolution> {
  const value = body['resolutions']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WebApiError('INVALID_REQUEST', 'Field "resolutions" must be an object')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    throw new WebApiError('INVALID_REQUEST', 'Field "resolutions" must not be empty')
  }
  const resolutions: Record<string, ConflictResolution> = {}
  for (const [conflictId, resolution] of entries) {
    if (typeof resolution !== 'string' || !CONFLICT_RESOLUTIONS.has(resolution)) {
      throw new WebApiError(
        'INVALID_REQUEST',
        `Field "resolutions.${conflictId}" must be one of ${[...CONFLICT_RESOLUTIONS].join('/')}`,
      )
    }
    resolutions[conflictId] = resolution as ConflictResolution
  }
  return resolutions
}

/** A `conflicts`/`blocked` sync outcome is a normal result, reported via HTTP status, not thrown. */
function syncOutcomeStatus(outcome: SyncOutcome): number {
  if (outcome.kind === 'completed') return 200
  if (outcome.kind === 'conflicts') return 409
  return 423
}

function presentSyncOutcome(outcome: SyncOutcome): SyncResponse['sync'] {
  if (outcome.kind === 'completed') {
    return {
      kind: 'completed',
      automaticallyMerged: outcome.summary.automaticallyMerged,
      retriedPushes: outcome.summary.retriedPushes,
      ...(outcome.summary.createdSnapshotId === undefined
        ? {}
        : { snapshotId: outcome.summary.createdSnapshotId }),
    }
  }
  if (outcome.kind === 'conflicts') {
    return {
      kind: 'conflicts',
      sessionId: outcome.session.id,
      conflictCount: outcome.session.conflicts.length,
      snapshotId: outcome.session.snapshotId,
    }
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

function presentConflictSession(session: ConflictSession): ConflictResponse['conflict'] {
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    snapshotId: session.snapshotId,
    conflicts: session.conflicts.map(presentSyncConflict),
  }
}

function presentSyncConflict(
  conflict: SyncConflict,
): ConflictResponse['conflict']['conflicts'][number] {
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
  web?: { port?: number; host?: string; open?: boolean }
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
    if (raw.web.host !== undefined) {
      if (typeof raw.web.host !== 'string' || raw.web.host.trim().length === 0) {
        throw new WebApiError('INVALID_REQUEST', 'Field "web.host" must be a non-empty string')
      }
      web.host = raw.web.host.trim()
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
      if (value.path !== undefined && typeof value.path !== 'string') {
        throw new WebApiError(
          'INVALID_REQUEST',
          `Agent override "${agentId}" path must be a string`,
        )
      }
      let skillDirectories: string[] | undefined
      if (value.skillDirectories !== undefined) {
        if (
          !Array.isArray(value.skillDirectories) ||
          value.skillDirectories.length === 0 ||
          value.skillDirectories.some(
            (item) => typeof item !== 'string' || item.trim().length === 0,
          )
        ) {
          throw new WebApiError(
            'INVALID_REQUEST',
            `Agent override "${agentId}" skillDirectories must be a non-empty string array`,
          )
        }
        skillDirectories = value.skillDirectories.map((item) => item.trim())
      }
      if (value.path === undefined && skillDirectories === undefined) {
        throw new WebApiError(
          'INVALID_REQUEST',
          `Agent override "${agentId}" has no editable fields`,
        )
      }
      agents[agentId] = {
        ...(value.path === undefined ? {} : { path: value.path }),
        ...(skillDirectories === undefined ? {} : { skillDirectories }),
      }
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
    if (patch.web.host !== undefined) {
      mergedWeb.host = patch.web.host
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
      const entry: { path?: string; executable?: string; skillDirectories?: string[] } = {}
      if (existing !== undefined) {
        if (existing.path !== undefined) entry.path = existing.path
        if (existing.executable !== undefined) entry.executable = existing.executable
        if (existing.skillDirectories !== undefined)
          entry.skillDirectories = [...existing.skillDirectories]
      }
      touched = true
      if (override.path !== undefined) {
        if (override.path.length === 0) delete entry.path
        else {
          entry.path = override.path
          delete entry.executable
        }
      }
      if (override.skillDirectories !== undefined)
        entry.skillDirectories = [...override.skillDirectories]
      if (Object.keys(entry).length === 0) {
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
