/**
 * Typed client for the M10 JSON API served by the Skillbox web server
 * (packages/cli/src/web/app.ts). Every request mirrors a Hono route and the
 * M10.8 error envelope `{ error: { code, message, recoverable, rollback? } }`.
 */

export interface HealthStatus {
  status: 'ok'
  name: string
  version: string
  repository: string
  home: string
}

export interface SkillStatusEntry {
  name: string
  mode: 'managed' | 'forked' | 'local' | 'vendored'
  status: 'ready' | 'modified' | 'outdated' | 'conflict' | 'missing' | 'broken'
  path?: string
  integrity?: string
  lockIntegrity?: string
  agents: string[]
  message?: string
}

export interface AgentCapabilities {
  supportsGlobalSkills: boolean
  supportsProjectSkills: boolean
  supportsSymlinks: boolean
  supportsNestedSkillDirectories: boolean
  requiresRestartAfterChange: boolean
}

export interface AgentSummary {
  id: string
  name: string
  capabilities: AgentCapabilities
  detected: boolean
  confidence: 'high' | 'medium' | 'low'
  skillDirectories: string[]
  version?: string
  executable?: string
  skillCount: number
  managedSkillCount: number
  externalSkillCount: number
}

export interface SkillContent {
  name: string
  path: string
  markdown: string
}

export interface CreatedSkill {
  name: string
  path: string
  manifestWritten: boolean
  lockfileWritten: boolean
  materialized: { path: string }
}

export interface SavedSkillContent {
  name: string
  path: string
  integrity: string
  lockIntegrity?: string
  status: 'ready' | 'modified'
}

export interface AgentAssignment {
  name: string
  agent: string
  manifestChanged: boolean
}

export interface ReconcileReport {
  changed: boolean
  repository: string
  skills: unknown[]
  staleLinks: unknown[]
  agents: unknown[]
  problems: { code: string; alias?: string; message: string }[]
}

/** V0.5 personal library — result of `POST /api/library/adopt`. */
export interface AdoptReport {
  scanned: number
  imported: number
  unchanged: number
  conflicts: number
  skipped: Array<{ name: string; agents: string[]; reason: string }>
}

export interface RepositoryStatus {
  repositoryRoot: string
  manifestPath: string
  manifestPresent: boolean
  lockfilePath: string
  lockfilePresent: boolean
  skills: SkillStatusEntry[]
  modified: string[]
  broken: string[]
  agents: AgentSummary[]
}

export type LinkStrategy = 'auto' | 'symlink' | 'junction' | 'copy'

/** Machine config persisted at `~/.skillbox/config.json` (GAP 1.2). */
export interface RuntimeSettingsInput {
  linkStrategy?: LinkStrategy
  web?: { port?: number; host?: string; open?: boolean }
  agents?: Record<string, { path?: string; executable?: string; skillDirectories?: string[] }>
  library?: LibrarySettings
}

/** Personal library (`<home>/personal`) behaviour on this machine. */
export interface LibrarySettings {
  /** Adopt agent skills automatically when the Web UI opens an empty library. */
  autoAdopt?: boolean
  /** Agent ids whose skills are left where they are. */
  ignoreAgents?: string[]
  /** Skill names that are never imported. */
  ignoreSkills?: string[]
}

/**
 * The editable subset of the Machine Config accepted by `PUT /api/settings`.
 * Agent overrides carry a `path` (a non-empty string sets it; an empty string
 * removes the override).
 */
export interface SettingsPatch {
  linkStrategy?: LinkStrategy
  web?: { port?: number; host?: string; open?: boolean }
  agents?: Record<string, { path?: string; skillDirectories?: string[] }>
  library?: LibrarySettings
}

/* ---- V0.3 registry API (M14.7 Explore / M15 install / M16.3 updates) ---- */

/** Aggregated risk level of a remote skill per the Security Scanner. */
export type RegistryRisk = 'low' | 'medium' | 'high'

/** A single Security Scanner finding attached to a registry result. */
export interface RegistryFinding {
  severity: 'info' | 'warning' | 'high'
  /** Rule id that produced the finding, e.g. `network-access`. */
  rule: string
  /** Human readable explanation of the finding. */
  message: string
}

/** One result of the aggregated registry search (GAP §3 Explore). */
export interface RegistrySearchResult {
  /** Skill name as shown to the user. */
  name: string
  /** Normalized source that can be passed back to install, e.g. `github:acme/react-skill`. */
  source: string
  /** Registry provider this result came from, e.g. `github` | `skills-sh` | `local`. */
  provider: string
  description?: string
  version?: string
  revision?: string
  /** Download / use count used by the popularity sort. */
  popularity?: number
  trending?: boolean
  official?: boolean
  verified?: boolean
  /** Whether the provider already ran a security review on this result. */
  securityReviewed?: boolean
  securityRisk?: RegistryRisk
  /** Best-effort findings advertised by the provider (server scans at install time). */
  securityFindings?: RegistryFinding[]
  /** True when the same source is already installed in this repository. */
  installed?: boolean
}

/** Query parameters accepted by `GET /api/registry/search`. */
export interface RegistrySearchParams {
  q?: string
  provider?: string
  sort?: 'popularity' | 'recently-updated'
  trending?: boolean
  official?: boolean
}

/** One row of the Updates page (M16.3). */
export interface OutdatedSkill {
  name: string
  /** Manifest source of the installed skill, reused when updating it. */
  source: string
  /** Installed version or revision as shown on the Updates page. */
  installed: string
  /** Latest available version or revision. */
  latest: string
  /** Human readable list of what changed between installed and latest. */
  changes: string[]
  /** Aggregated risk of the latest revision, when a security review exists. */
  securityRisk?: RegistryRisk
  /** Agents the skill is currently enabled for (used to re-run install). */
  agents: string[]
}

/** Security portion of an install result. */
export interface InstallSecurity {
  risk: RegistryRisk
  scannedAt?: string
  findings: RegistryFinding[]
}

/** Input of `POST /api/registry/install` (M15 remote install). */
export interface InstallInput {
  source: string
  targetAgents: string[]
  /** `safe` refuses high-risk installations; `all` allows them after explicit confirmation. */
  allowPolicy: 'safe' | 'all'
}

/** Outcome of a remote install transaction (agent 2). */
export interface InstallResult {
  /** Skill alias written to the manifest + lockfile. */
  name: string
  source: string
  revision?: string
  /** Absolute path of the materialized skill directory. */
  path: string
  security: InstallSecurity
  agents: string[]
  /** True when the manifest changed on this install. */
  manifestChanged: boolean
  /** True when the lockfile changed on this install. */
  lockfileChanged: boolean
}

/* ---- V0.4 skill diff API (M19.5) ---- */

/** One changed file of a skill diff view. */
export interface SkillFileDiff {
  /** Portable relative path (forward slashes). */
  path: string
  status: 'added' | 'modified' | 'deleted'
  /** Unified-diff body for this file (empty for binary files). */
  patch: string
  /** True for binary files, whose contents are never rendered. */
  binary?: boolean
}

/** One comparison of a skill (e.g. `Current vs Latest`). */
export interface SkillDiffView {
  label: string
  files: SkillFileDiff[]
}

/** Result of `GET /api/skills/:id/diff`. */
export interface SkillDiff {
  name: string
  mode: 'managed' | 'forked'
  views: SkillDiffView[]
  /** True when every view has no changes — the "No changes" case. */
  unchanged: boolean
}

/* ---- V0.4 lifecycle API (M17 fork/vendor/restore, M20 merge) ---- */

/** One lifecycle operation's outcome, rendered by the Web UI. */
export interface LifecycleOperationResult {
  name: string
  action: 'forked' | 'vendored' | 'restored' | 'merged' | 'continued' | 'aborted'
  /** Repo-relative path of the forked/vendored copy (when applicable). */
  localPath?: string
  /** Revision the skill is based on / restored to (when applicable). */
  revision?: string
  /** Files restored to the lockfile integrity (restore / merge abort). */
  filesRestored?: number
  /** Files merged (3-way merge). */
  filesMerged?: number
  /** Conflict hunks left in the content (0 = clean merge). */
  changes?: number
  /** Conflicts left after a merge / continue (empty = clean). */
  conflicts?: Array<{ path: string; hunks: number; reason?: string }>
  /** New base revision after a clean merge. */
  baseRevision?: string
}

/** Merge action accepted by `POST /api/skills/:id/merge`. */
export type MergeAction = 'merge' | 'continue' | 'abort'

export interface BackupRecord {
  id: string
  kind: 'runtime' | 'repo-dir'
  operation: string
  alias: string
  createdAt: string
  path: string
  sourcePath: string
  repositoryRoot: string
}

export interface RollbackResult {
  id: string
  kind: 'runtime' | 'repo-dir'
  operation: string
  alias: string
  filesRestored: number
  path: string
}

/** One remote machine from `.skillbox/fleet.yaml` (Fleet: multi-host SSH orchestration). */
export interface FleetHostConfig {
  name: string
  host: string
  user?: string
  port?: number
  identityFile?: string
  remotePath?: string
  skillboxBin?: string
  tags?: string[]
}

export type FleetOperationName =
  'install' | 'update' | 'status' | 'remove' | 'enable' | 'disable' | 'sync' | 'ping'

/** A skill (and, for enable/disable, agent) a Fleet run targets. */
export interface FleetSkillTarget {
  name: string
  /** Required for enable/disable. */
  agent?: string
  /** remove only: also delete the skill's files, not just its manifest entry. */
  deleteFiles?: boolean
  /** update only: confirm a HIGH-risk update non-interactively. */
  yes?: boolean
}

export interface FleetHostResult {
  host: string
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  error?: string
}

export interface FleetRunResult {
  operation: FleetOperationName
  results: FleetHostResult[]
}

/** Body of `POST /api/fleet/run`: named/tagged config hosts, plus ad-hoc `--ssh`-style entries. */
export interface FleetRunRequest {
  operation: FleetOperationName
  hosts?: string[]
  tags?: string[]
  ssh?: string[]
  concurrency?: number
  /** Extra attempts for hosts whose SSH connection failed (exit 255 / timeout). */
  retries?: number
  dryRun?: boolean
  /** Required for remove/enable/disable; optional for update (targets one skill). */
  target?: FleetSkillTarget
}

/** Body of `POST /api/fleet/hosts`. */
export type FleetHostInput = FleetHostConfig

/** Body of `PATCH /api/fleet/hosts/:name` — every field replaces the current value; `name` renames the host. */
export type FleetHostPatch = Partial<FleetHostConfig>

/* ---- Multi-device sync (RepositorySync) ----
 * `connect`/`disconnect` stay CLI-only (`skillbox connect`) — the GitHub
 * device-flow handshake takes minutes and doesn't fit a request/response
 * cycle. This client only covers day-to-day sync once already connected.
 */

/** Presentation-only state returned by the sync API. */
export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'completed'; automaticallyMerged: number; snapshotId?: string; retriedPushes: number }
  | { kind: 'conflicts'; sessionId: string; conflictCount: number; snapshotId: string }
  | { kind: 'blocked'; reason: string; message: string; retryable: boolean; snapshotId?: string }

/** GitHub connection snapshot — read-only, never starts a device flow. */
export interface SyncConnection {
  connected: boolean
  login?: string
  repository?: string
}

export interface SyncStatusView {
  sync: SyncStatus
  connection: SyncConnection
}

/** One restorable sync checkpoint from `GET /api/sync/snapshots`. */
export interface SyncSnapshotView {
  id: string
  createdAt: string
  expiresAt: string
  revision: string
  expired: boolean
}

export type ConflictChoice = 'local' | 'remote' | 'keep-both' | 'delete' | 'restore' | 'merged'
export type SyncConflictKind =
  'content' | 'delete-modify' | 'manifest-field' | 'mode' | 'source' | 'lifecycle'

export interface SyncConflictView {
  id: string
  type: SyncConflictKind
  skillAlias?: string
  path?: string
  field?: string
  basePreview?: string
  localPreview?: string
  remotePreview?: string
  allowedResolutions: ConflictChoice[]
  recommendedResolution?: ConflictChoice
  destructive: boolean
}

export interface ConflictSessionView {
  id: string
  snapshotId: string
  createdAt: string
  expiresAt: string
  conflicts: SyncConflictView[]
}

export interface ResolveSyncConflictsInput {
  resolutions: Record<string, ConflictChoice>
}

/* ---- Diagnostics (`GET /api/doctor`) ---- */

/** One probe result from the doctor report. */
export interface DoctorProbe {
  name: string
  ok: boolean
  detail?: string
  error?: string
}

export interface DoctorReport {
  generatedAt: string
  skillboxVersion: string
  probes: DoctorProbe[]
}

/**
 * One sync cleanup step the server could not finish while rolling a failed
 * transaction back.  Mirrors `SyncRollbackFailureDto` in
 * `packages/cli/src/web/types.ts`; the server whitelists these fields one by one
 * and never exports the rest of the error's context.
 */
export interface SyncRollbackFailureView {
  step: 'abort-merge' | 'restore' | 'remove-worktree' | 'remove-tree'
  /** Restore-point id or temporary sync-tree path the step was working on. */
  target: string
  /** Failure reason, secret-scrubbed server-side. */
  message: string
  blocking: boolean
}

/**
 * Data form of the rollback report a failed `sync`/conflict-resolve leaves behind
 * (GAP §4.6).  `restoreFailed` is the actionable one: the working tree may still
 * hold mid-transaction state.
 *
 * Note before rendering it: the server deliberately keeps the same facts in
 * `error.message` too, because the CLI and the log lines print only that field.
 * A banner built from `rollback` therefore restates what the generic error text
 * already says — render one or the other, not both.
 */
export interface SyncRollbackView {
  snapshotId: string
  restoreFailed: boolean
  failures: SyncRollbackFailureView[]
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    recoverable: boolean
    /** Only present when a failed sync could not finish restoring the working tree. */
    rollback?: SyncRollbackView
  }
}

/** Error thrown when the API answers with a non-2xx status (M10.8 envelope). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly recoverable: boolean

  constructor(status: number, code: string, message: string, recoverable: boolean) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.recoverable = recoverable
  }
}

/**
 * A sync conflict or a safely-paused sync is an expected workflow result,
 * not an API failure — the server deliberately answers those with 409/423
 * instead of 200. `acceptedStatuses` lets those specific calls treat such a
 * response as a normal body instead of throwing; every other non-2xx status
 * still becomes an `ApiError`.
 */
async function request<T>(
  path: string,
  init?: RequestInit,
  acceptedStatuses: readonly number[] = [],
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })

  let body: unknown = undefined
  try {
    body = await response.json()
  } catch {
    body = undefined
  }

  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    const envelope = body as ApiErrorBody | undefined
    if (envelope?.error !== undefined) {
      const { code, message, recoverable } = envelope.error
      throw new ApiError(response.status, code, message, recoverable)
    }
    throw new ApiError(
      response.status,
      'HTTP_ERROR',
      `Request failed with status ${response.status}`,
      false,
    )
  }

  if (body === undefined) {
    throw new ApiError(502, 'EMPTY_RESPONSE', 'The API returned an empty response.', false)
  }
  return body as T
}

export interface ApiClient {
  health(): Promise<HealthStatus>
  skills(): Promise<SkillStatusEntry[]>
  skill(name: string): Promise<SkillStatusEntry>
  skillContent(name: string): Promise<SkillContent>
  agents(): Promise<AgentSummary[]>
  status(): Promise<RepositoryStatus>
  settings(): Promise<RuntimeSettingsInput>
  saveSettings(patch: SettingsPatch): Promise<RuntimeSettingsInput>
  createSkill(input: { name: string; description?: string }): Promise<CreatedSkill>
  saveSkillContent(name: string, content: string): Promise<SavedSkillContent>
  removeSkill(name: string): Promise<void>
  enableSkill(name: string, agent: string): Promise<AgentAssignment>
  disableSkill(name: string, agent: string): Promise<AgentAssignment>
  reconcile(): Promise<ReconcileReport>
  adoptLibrary(): Promise<AdoptReport>
  /* V0.3 registry API */
  registrySearch(params?: RegistrySearchParams): Promise<RegistrySearchResult[]>
  outdated(): Promise<OutdatedSkill[]>
  installRegistrySkill(input: InstallInput): Promise<InstallResult>
  /* V0.4 diff API */
  skillDiff(name: string): Promise<SkillDiff>
  /* V0.4 lifecycle API */
  forkSkill(name: string): Promise<LifecycleOperationResult>
  vendorSkill(name: string): Promise<LifecycleOperationResult>
  restoreSkill(name: string): Promise<LifecycleOperationResult>
  mergeSkill(name: string, action?: MergeAction): Promise<LifecycleOperationResult>
  rollbacks(): Promise<BackupRecord[]>
  restoreRollback(id: string): Promise<RollbackResult>
  /* Fleet API */
  fleetHosts(): Promise<FleetHostConfig[]>
  fleetRun(input: FleetRunRequest, signal?: AbortSignal): Promise<FleetRunResult>
  addFleetHost(input: FleetHostInput): Promise<FleetHostConfig>
  updateFleetHost(name: string, patch: FleetHostPatch): Promise<FleetHostConfig>
  removeFleetHost(name: string): Promise<void>
  /* Multi-device sync API */
  syncStatus(): Promise<SyncStatusView>
  sync(): Promise<SyncStatus>
  syncSnapshots(): Promise<SyncSnapshotView[]>
  conflicts(): Promise<ConflictSessionView[]>
  conflict(id: string): Promise<ConflictSessionView>
  resolveConflicts(id: string, input: ResolveSyncConflictsInput): Promise<SyncStatus>
  restoreSyncSnapshot(id: string): Promise<void>
  disconnectSync(): Promise<void>
  /* Diagnostics */
  doctor(): Promise<DoctorReport>
}

function encodeName(name: string): string {
  return encodeURIComponent(name)
}

export const api: ApiClient = {
  async health() {
    return request<HealthStatus>('/api/health')
  },

  async skills() {
    const response = await request<{ skills: SkillStatusEntry[] }>('/api/skills')
    return response.skills
  },

  async skill(name) {
    const response = await request<{ skill: SkillStatusEntry }>(`/api/skills/${encodeName(name)}`)
    return response.skill
  },

  async skillContent(name) {
    const response = await request<{ skill: SkillContent }>(
      `/api/skills/${encodeName(name)}/content`,
    )
    return response.skill
  },

  async agents() {
    const response = await request<{ agents: AgentSummary[] }>('/api/agents')
    return response.agents
  },

  async status() {
    return request<RepositoryStatus>('/api/status')
  },

  async settings() {
    const response = await request<{ settings: RuntimeSettingsInput }>('/api/settings')
    return response.settings
  },

  async saveSettings(patch) {
    const response = await request<{ settings: RuntimeSettingsInput }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: patch }),
    })
    return response.settings
  },

  async createSkill(input) {
    const response = await request<{ created: CreatedSkill }>('/api/skills', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return response.created
  },

  async saveSkillContent(name, content) {
    const response = await request<{ saved: SavedSkillContent }>(
      `/api/skills/${encodeName(name)}/content`,
      { method: 'PUT', body: JSON.stringify({ content }) },
    )
    return response.saved
  },

  async removeSkill(name) {
    await request<unknown>(`/api/skills/${encodeName(name)}`, { method: 'DELETE' })
  },

  async enableSkill(name, agent) {
    const response = await request<{ assignment: AgentAssignment }>(
      `/api/skills/${encodeName(name)}/enable`,
      { method: 'POST', body: JSON.stringify({ agent }) },
    )
    return response.assignment
  },

  async disableSkill(name, agent) {
    const response = await request<{ assignment: AgentAssignment }>(
      `/api/skills/${encodeName(name)}/disable`,
      { method: 'POST', body: JSON.stringify({ agent }) },
    )
    return response.assignment
  },

  async reconcile() {
    const response = await request<{ reconcile: ReconcileReport }>('/api/reconcile', {
      method: 'POST',
    })
    return response.reconcile
  },

  async adoptLibrary() {
    const response = await request<{ report: AdoptReport }>(
      '/api/library/adopt',
      { method: 'POST' },
      [201],
    )
    return response.report
  },

  async registrySearch(params) {
    const query = new URLSearchParams()
    if (params?.q !== undefined && params.q !== '') {
      query.set('q', params.q)
    }
    if (params?.provider !== undefined && params.provider !== '') {
      query.set('provider', params.provider)
    }
    if (params?.sort !== undefined) {
      query.set('sort', params.sort)
    }
    if (params?.trending === true) {
      query.set('trending', '1')
    }
    if (params?.official === true) {
      query.set('official', '1')
    }
    const encoded = query.toString()
    const response = await request<{ results: RegistrySearchResult[] }>(
      `/api/registry/search${encoded === '' ? '' : `?${encoded}`}`,
    )
    return response.results
  },

  async outdated() {
    const response = await request<{ outdated: OutdatedSkill[] }>('/api/registry/outdated')
    return response.outdated
  },

  async installRegistrySkill(input) {
    const response = await request<{ installed: InstallResult }>('/api/registry/install', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return response.installed
  },

  async skillDiff(name) {
    const response = await request<{ diff: SkillDiff }>(`/api/skills/${encodeName(name)}/diff`)
    return response.diff
  },

  async forkSkill(name) {
    const response = await request<{ result: LifecycleOperationResult }>(
      `/api/skills/${encodeName(name)}/fork`,
      { method: 'POST' },
    )
    return response.result
  },

  async vendorSkill(name) {
    const response = await request<{ result: LifecycleOperationResult }>(
      `/api/skills/${encodeName(name)}/vendor`,
      { method: 'POST' },
    )
    return response.result
  },

  async restoreSkill(name) {
    const response = await request<{ result: LifecycleOperationResult }>(
      `/api/skills/${encodeName(name)}/restore`,
      { method: 'POST' },
    )
    return response.result
  },

  async mergeSkill(name, action = 'merge') {
    const response = await request<{ result: LifecycleOperationResult }>(
      `/api/skills/${encodeName(name)}/merge`,
      { method: 'POST', body: JSON.stringify({ action }) },
    )
    return response.result
  },

  async rollbacks() {
    const response = await request<{ rollbacks: BackupRecord[] }>('/api/rollbacks')
    return response.rollbacks
  },

  async restoreRollback(id) {
    const response = await request<{ rollback: RollbackResult }>(
      `/api/rollbacks/${encodeURIComponent(id)}/restore`,
      { method: 'POST' },
    )
    return response.rollback
  },

  async fleetHosts() {
    const response = await request<{ hosts: FleetHostConfig[] }>('/api/fleet/hosts')
    return response.hosts
  },

  async fleetRun(input, signal) {
    const response = await request<{ result: FleetRunResult }>('/api/fleet/run', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    })
    return response.result
  },

  async addFleetHost(input) {
    const response = await request<{ host: FleetHostConfig }>('/api/fleet/hosts', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return response.host
  },

  async updateFleetHost(name, patch) {
    const response = await request<{ host: FleetHostConfig }>(
      `/api/fleet/hosts/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    )
    return response.host
  },

  async removeFleetHost(name) {
    await request<unknown>(`/api/fleet/hosts/${encodeURIComponent(name)}`, { method: 'DELETE' })
  },

  async syncStatus() {
    return request<SyncStatusView>('/api/sync/status')
  },

  async syncSnapshots() {
    const response = await request<{ snapshots: SyncSnapshotView[] }>('/api/sync/snapshots')
    return response.snapshots
  },

  async sync() {
    const response = await request<{ sync: SyncStatus }>(
      '/api/sync',
      { method: 'POST' },
      [409, 423],
    )
    return response.sync
  },

  async conflicts() {
    const response = await request<{ conflicts: ConflictSessionView[] }>('/api/conflicts')
    return response.conflicts
  },

  async conflict(id) {
    const response = await request<{ conflict: ConflictSessionView }>(
      `/api/conflicts/${encodeName(id)}`,
    )
    return response.conflict
  },

  async resolveConflicts(id, input) {
    const response = await request<{ sync: SyncStatus }>(
      `/api/conflicts/${encodeName(id)}/resolve`,
      { method: 'POST', body: JSON.stringify(input) },
      [409, 423],
    )
    return response.sync
  },

  async restoreSyncSnapshot(id) {
    await request<unknown>(`/api/sync/snapshots/${encodeName(id)}/restore`, { method: 'POST' })
  },

  async disconnectSync() {
    await request<unknown>('/api/sync/disconnect', { method: 'POST' })
  },

  async doctor() {
    const response = await request<{ report: DoctorReport }>('/api/doctor')
    return response.report
  },
}
