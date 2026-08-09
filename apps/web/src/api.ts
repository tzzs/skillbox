/**
 * Typed client for the M10 JSON API served by the Skillbox web server
 * (packages/cli/src/web/app.ts). Every request mirrors a Hono route and the
 * M10.8 error envelope `{ error: { code, message, recoverable } }`.
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
  web?: { port?: number; open?: boolean }
  agents?: Record<string, { path?: string; executable?: string }>
}

/**
 * The editable subset of the Machine Config accepted by `PUT /api/settings`.
 * Agent overrides carry a `path` (a non-empty string sets it; an empty string
 * removes the override).
 */
export interface SettingsPatch {
  linkStrategy?: LinkStrategy
  web?: { port?: number; open?: boolean }
  agents?: Record<string, { path: string }>
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

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    recoverable: boolean
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

  if (!response.ok) {
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
  /* V0.3 registry API */
  registrySearch(params?: RegistrySearchParams): Promise<RegistrySearchResult[]>
  outdated(): Promise<OutdatedSkill[]>
  installRegistrySkill(input: InstallInput): Promise<InstallResult>
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
}
