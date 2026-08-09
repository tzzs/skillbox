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
}
