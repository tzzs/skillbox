import type {
  AgentRegistry,
  ReconcileResult,
  RepositoryStatus,
  SkillService,
  StatusService,
} from '@skillbox/core'

/**
 * The Core services the Web layer is allowed to talk to. Every API route goes
 * through one of these services; the web layer never touches skill files or
 * manifests directly (M10.6).
 */
export interface WebServices {
  registry: AgentRegistry
  skills: SkillService
  status: StatusService
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
