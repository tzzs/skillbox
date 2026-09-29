/**
 * Typed client for the M10 JSON API served by the Skillbox web server
 * (packages/cli/src/web/app.ts). Every request mirrors a Hono route and the
 * M10.8 error envelope `{ error: { code, message, recoverable, rollback? } }`.
 *
 * The *shapes* come from `@skillbox/shared` (`src/web-api.ts`) — the same module
 * the server types its responses with, so neither side can describe a route in
 * its own words any more. Only the calling machinery below is client-specific.
 * Every import is `import type`, so the SPA gains no runtime dependency on the
 * contract module: it erases at build time.
 *
 * The names this file used to define are kept as aliases of the contract's
 * names (`AgentSummary`, `ConflictChoice`, …) so existing screens keep
 * compiling; the alias is a second *name* for one type, never a second copy.
 */

import type {
  AdoptReport,
  AdoptResponse,
  AgentAssignmentResponse,
  AgentAssignmentResult as AgentAssignment,
  AgentCapabilities,
  AgentDetectionSummary as AgentSummary,
  AgentsResponse,
  ApiErrorBody,
  BackupRecord,
  ConflictResolution as ConflictChoice,
  ConflictResponse,
  ConflictSessionDto as ConflictSessionView,
  ConflictType as SyncConflictKind,
  ConflictsResponse,
  CreateSkillInput,
  CreateSkillResponse,
  CreateSkillResult as CreatedSkill,
  DoctorReport,
  DoctorResponse,
  FleetHostConfig,
  FleetHostCreateRequest as FleetHostInput,
  FleetHostPatchRequest as FleetHostPatch,
  FleetHostResponse,
  FleetHostResult,
  FleetHostsResponse,
  FleetOperationName,
  FleetRunRequest,
  FleetRunResponse,
  FleetRunResult,
  FleetSkillTarget,
  HealthResponse as HealthStatus,
  InstallInput,
  InstallResponse,
  InstallResult,
  InstallSecurity,
  LibrarySettings,
  LifecycleOperationResult,
  LifecycleResultResponse,
  LinkStrategy,
  MergeAction,
  OutdatedResponse,
  OutdatedSkill,
  ProbeResult as DoctorProbe,
  ReconcileResponse,
  ReconcileResult as ReconcileReport,
  RegistryFinding,
  RegistryRisk,
  RegistrySearchResponse,
  RegistrySearchResult,
  RegistrySearchParams,
  RepositoryStatus,
  ResolveSyncConflictsInput,
  RollbackListResponse,
  RollbackRestoreResponse,
  RollbackResult,
  RuntimeConfig as RuntimeSettingsInput,
  SaveSkillContentResponse,
  SavedSkillContent,
  SettingsPatch,
  SettingsResponse,
  SkillContent,
  SkillContentResponse,
  SkillDiff,
  SkillDiffResponse,
  SkillDiffView,
  SkillFileDiff,
  SkillResponse,
  SkillStatusEntry,
  SkillsResponse,
  StatusResponse,
  SyncConflictDto as SyncConflictView,
  SyncConnectionDto as SyncConnection,
  SyncOutcomeDto as SyncStatus,
  SyncResponse,
  SyncRollbackDto as SyncRollbackView,
  SyncRollbackFailureDto as SyncRollbackFailureView,
  SyncSnapshotDto as SyncSnapshotView,
  SyncSnapshotsResponse,
  SyncStatusResponse as SyncStatusView,
} from '@skillbox/shared'

/* Re-exported so screens keep importing them from `./api.js`. */
export type {
  AdoptReport,
  AgentAssignment,
  AgentCapabilities,
  AgentSummary,
  ApiErrorBody,
  BackupRecord,
  ConflictChoice,
  ConflictSessionView,
  CreatedSkill,
  DoctorProbe,
  DoctorReport,
  FleetHostConfig,
  FleetHostInput,
  FleetHostPatch,
  FleetHostResult,
  FleetOperationName,
  FleetRunRequest,
  FleetRunResult,
  FleetSkillTarget,
  HealthStatus,
  InstallInput,
  InstallResult,
  InstallSecurity,
  LibrarySettings,
  LifecycleOperationResult,
  LinkStrategy,
  MergeAction,
  OutdatedSkill,
  ReconcileReport,
  RegistryFinding,
  RegistryRisk,
  RegistrySearchResult,
  RegistrySearchParams,
  RepositoryStatus,
  ResolveSyncConflictsInput,
  RollbackResult,
  RuntimeSettingsInput,
  SavedSkillContent,
  SettingsPatch,
  SkillContent,
  SkillDiff,
  SkillDiffView,
  SkillFileDiff,
  SkillStatusEntry,
  SyncConnection,
  SyncConflictKind,
  SyncConflictView,
  SyncRollbackView,
  SyncRollbackFailureView,
  SyncSnapshotView,
  SyncStatus,
  SyncStatusView,
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
  createSkill(input: CreateSkillInput): Promise<CreatedSkill>
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
    const response = await request<SkillsResponse>('/api/skills')
    return response.skills
  },

  async skill(name) {
    const response = await request<SkillResponse>(`/api/skills/${encodeName(name)}`)
    return response.skill
  },

  async skillContent(name) {
    const response = await request<SkillContentResponse>(`/api/skills/${encodeName(name)}/content`)
    return response.skill
  },

  async agents() {
    const response = await request<AgentsResponse>('/api/agents')
    return response.agents
  },

  async status() {
    return request<StatusResponse>('/api/status')
  },

  async settings() {
    const response = await request<SettingsResponse>('/api/settings')
    return response.settings
  },

  async saveSettings(patch) {
    const response = await request<SettingsResponse>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: patch }),
    })
    return response.settings
  },

  async createSkill(input) {
    const response = await request<CreateSkillResponse>('/api/skills', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return response.created
  },

  async saveSkillContent(name, content) {
    const response = await request<SaveSkillContentResponse>(
      `/api/skills/${encodeName(name)}/content`,
      { method: 'PUT', body: JSON.stringify({ content }) },
    )
    return response.saved
  },

  async removeSkill(name) {
    await request<unknown>(`/api/skills/${encodeName(name)}`, { method: 'DELETE' })
  },

  async enableSkill(name, agent) {
    const response = await request<AgentAssignmentResponse>(
      `/api/skills/${encodeName(name)}/enable`,
      { method: 'POST', body: JSON.stringify({ agent }) },
    )
    return response.assignment
  },

  async disableSkill(name, agent) {
    const response = await request<AgentAssignmentResponse>(
      `/api/skills/${encodeName(name)}/disable`,
      { method: 'POST', body: JSON.stringify({ agent }) },
    )
    return response.assignment
  },

  async reconcile() {
    const response = await request<ReconcileResponse>('/api/reconcile', {
      method: 'POST',
    })
    return response.reconcile
  },

  async adoptLibrary() {
    const response = await request<AdoptResponse>('/api/library/adopt', { method: 'POST' }, [201])
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
    const response = await request<RegistrySearchResponse>(
      `/api/registry/search${encoded === '' ? '' : `?${encoded}`}`,
    )
    return response.results
  },

  async outdated() {
    const response = await request<OutdatedResponse>('/api/registry/outdated')
    return response.outdated
  },

  async installRegistrySkill(input) {
    const response = await request<InstallResponse>('/api/registry/install', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return response.installed
  },

  async skillDiff(name) {
    const response = await request<SkillDiffResponse>(`/api/skills/${encodeName(name)}/diff`)
    return response.diff
  },

  async forkSkill(name) {
    const response = await request<LifecycleResultResponse>(
      `/api/skills/${encodeName(name)}/fork`,
      { method: 'POST' },
    )
    return response.result
  },

  async vendorSkill(name) {
    const response = await request<LifecycleResultResponse>(
      `/api/skills/${encodeName(name)}/vendor`,
      { method: 'POST' },
    )
    return response.result
  },

  async restoreSkill(name) {
    const response = await request<LifecycleResultResponse>(
      `/api/skills/${encodeName(name)}/restore`,
      { method: 'POST' },
    )
    return response.result
  },

  async mergeSkill(name, action = 'merge') {
    const response = await request<LifecycleResultResponse>(
      `/api/skills/${encodeName(name)}/merge`,
      { method: 'POST', body: JSON.stringify({ action }) },
    )
    return response.result
  },

  async rollbacks() {
    const response = await request<RollbackListResponse>('/api/rollbacks')
    return response.rollbacks
  },

  async restoreRollback(id) {
    const response = await request<RollbackRestoreResponse>(
      `/api/rollbacks/${encodeURIComponent(id)}/restore`,
      { method: 'POST' },
    )
    return response.rollback
  },

  async fleetHosts() {
    const response = await request<FleetHostsResponse>('/api/fleet/hosts')
    return response.hosts
  },

  async fleetRun(input, signal) {
    const response = await request<FleetRunResponse>('/api/fleet/run', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    })
    return response.result
  },

  async addFleetHost(input) {
    const response = await request<FleetHostResponse>('/api/fleet/hosts', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return response.host
  },

  async updateFleetHost(name, patch) {
    const response = await request<FleetHostResponse>(
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
    const response = await request<SyncSnapshotsResponse>('/api/sync/snapshots')
    return response.snapshots
  },

  async sync() {
    const response = await request<SyncResponse>('/api/sync', { method: 'POST' }, [409, 423])
    return response.sync
  },

  async conflicts() {
    const response = await request<ConflictsResponse>('/api/conflicts')
    return response.conflicts
  },

  async conflict(id) {
    const response = await request<ConflictResponse>(`/api/conflicts/${encodeName(id)}`)
    return response.conflict
  },

  async resolveConflicts(id, input) {
    const response = await request<SyncResponse>(
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
    const response = await request<DoctorResponse>('/api/doctor')
    return response.report
  },
}
