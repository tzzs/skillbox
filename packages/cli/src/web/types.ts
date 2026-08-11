import type {
  AgentRegistry,
  ReconcileResult,
  RepositoryStatus,
  RuntimeConfig,
  RuntimeConfigService,
  SkillDiff,
  SkillService,
  StatusService,
} from '@skillbox/core'

/**
 * V0.3 registry contract (M14.7). These shapes are the *web* front of the
 * Registry provider framework (agent 1: `packages/core/src/registry`) and the
 * Install/Updates layer (agent 2: `packages/core/src/install`). Until those
 * land the Web layer answers `REGISTRY_UNAVAILABLE`; the TODO wiring points
 * live in `services.ts`.
 */

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

/** Options accepted by the registry search service. */
export interface RegistrySearchOptions {
  provider?: string
  sort?: 'popularity' | 'recently-updated'
  trending?: boolean
  official?: boolean
}

/** Core search service contract (agent 1). */
export interface RegistrySearchService {
  search(query: string, options?: RegistrySearchOptions): Promise<RegistrySearchResult[]>
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

/** Outdated/updates computation service contract (agent 2). */
export interface UpdatesService {
  outdated(): Promise<OutdatedSkill[]>
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

/** Remote install transaction service contract (agent 2, M15.1). */
export interface InstallService {
  install(input: InstallInput): Promise<InstallResult>
}

/**
 * V0.4 skill diff computation (M19.5). Delegates to Core `diffSkill` — reads
 * the repository and the upstream provider only, never writes anything.
 */
export interface DiffService {
  /** Computes the diff views of one skill against its upstream. */
  diffSkill(name: string): Promise<SkillDiff>
}

/**
 * The Core services the Web layer is allowed to talk to. Every API route goes
 * through one of these services; the web layer never touches skill files or
 * manifests directly (M10.6).
 */
export interface WebServices {
  registry: AgentRegistry
  skills: SkillService
  status: StatusService
  /** Machine config ("~/.skillbox/config.json") read/write (GAP 1.2). */
  config: RuntimeConfigService
  /** V0.3 aggregated registry search (agent 1 contract). */
  search: RegistrySearchService
  /** V0.3 outdated / updates computation (agent 2 contract). */
  updates: UpdatesService
  /** V0.3 remote install transaction (agent 2 contract). */
  install: InstallService
  /** V0.4 skill diff computation (agent 2 contract). */
  diff: DiffService
  /** Absolute repository root the API operates on (identity info). */
  repositoryRoot: string
  /** Absolute Skillbox home root (identity info). */
  homeRoot: string
}

/** Unified error envelope required by M10.8. */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    recoverable: boolean
  }
}

/** Success shape of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok'
  name: string
  version: string
  repository: string
  home: string
}

/** Success shape of `GET /api/skills`. */
export interface SkillsResponse {
  skills: RepositoryStatus['skills']
}

/** Success shape of `GET /api/skills/:id`. */
export interface SkillResponse {
  skill: RepositoryStatus['skills'][number]
}

/** Success shape of `GET /api/agents`. */
export interface AgentsResponse {
  agents: Awaited<ReturnType<AgentRegistry['detectAll']>>
}

/** Success shape of `POST /api/reconcile`. */
export interface ReconcileResponse {
  reconcile: ReconcileResult
}

/** Success shape of `GET /api/settings` / `PUT /api/settings`. */
export interface SettingsResponse {
  settings: RuntimeConfig
}

/** Success shape of `GET /api/registry/search`. */
export interface RegistrySearchResponse {
  results: RegistrySearchResult[]
}

/** Success shape of `GET /api/registry/outdated`. */
export interface OutdatedResponse {
  outdated: OutdatedSkill[]
}

/** Success shape of `POST /api/registry/install`. */
export interface InstallResponse {
  installed: InstallResult
}

/** Success shape of `GET /api/skills/:id/diff` (M19.5). */
export interface SkillDiffResponse {
  diff: SkillDiff
}

/** Options accepted by {@link createWebApp}. */
export interface WebAppOptions {
  services: WebServices
  /** Absolute path of the frontend static assets (served at `/`). */
  staticDir?: string
  /** Product name + version reported by `GET /api/health`. */
  info?: { name: string; version: string }
}

/** Options accepted by the CLI `web` command and tests. */
export interface WebServerOptions {
  /** Repository root managed by the API. */
  repositoryRoot: string
  /** Skillbox home root (library + links state). */
  homeRoot: string
  /** Port to listen on. Defaults to 43821. */
  port?: number
  /** Host/interface to bind. Defaults to 127.0.0.1. */
  host?: string
  /** Open the browser automatically after the server starts. Defaults to true. */
  open?: boolean
  /** Absolute path of the frontend static assets. */
  staticDir?: string
  /** Registry used by the API; defaults to the built-in Claude + Codex. */
  registry?: AgentRegistry
  out?: (chunk: string) => void
  err?: (chunk: string) => void
}

/** Handle returned by {@link startWebServer}. */
export interface StartedWebServer {
  /** The bound Node HTTP server. */
  server: import('node:http').Server
  /** Actual bound port (may differ from the requested one). */
  port: number
  /** Public URL of the running server, e.g. `http://127.0.0.1:43821`. */
  url: string
  /** Close the server and stop accepting connections. */
  close(): Promise<void>
}
