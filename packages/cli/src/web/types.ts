/**
 * The Web layer's side of the API contract.
 *
 * Every *shape* the HTTP API exchanges — request bodies, response envelopes,
 * error envelope — is declared once in `@skillbox/shared` (`src/web-api.ts`) and
 * re-exported here, because `apps/web` consumes the same names from the same
 * module. What stays in this file is server-only by nature: the Core service
 * interfaces the routes delegate to, and the options/handles of the process
 * that hosts the server. Adding a response type here instead of there is how the
 * two sides drifted apart once already.
 *
 * V0.3 registry contract (M14.7): these shapes are the *web* front of the
 * Registry provider framework (agent 1: `packages/core/src/registry`) and the
 * Install/Updates layer (agent 2: `packages/core/src/install`). `services.ts`
 * wires every one of them to the real Core layer (`createSearchService`,
 * `createUpdatesService`, `createInstallService`); a Core failure keeps its
 * Skillbox code, so the M10.8 envelope can report the same reason the CLI
 * prints.
 */

import type {
  AgentRegistry,
  FleetService,
  RepositorySync,
  RuntimeConfigService,
  SkillService,
  StatusService,
} from '@skillbox/core'
import type {
  InstallInput,
  InstallResult,
  LifecycleOperationResult,
  MergeAction,
  OutdatedSkill,
  RegistrySearchResult,
  RegistrySearchSort,
  SkillDiff,
} from '@skillbox/shared'

export type {
  AdoptReport,
  AdoptResponse,
  AgentAssignmentResponse,
  AgentsResponse,
  ApiErrorBody,
  BackupRecord,
  CleanupStep,
  ConflictResolution,
  ConflictResponse,
  ConflictSessionDto,
  ConflictType,
  ConflictsResponse,
  CreateSkillInput,
  CreateSkillResponse,
  CreatedSkill,
  DoctorReport,
  DoctorResponse,
  FleetHostConfig,
  FleetHostCreateRequest,
  FleetHostPatchRequest,
  FleetHostRemoveResponse,
  FleetHostResponse,
  FleetHostsResponse,
  FleetOperationName,
  FleetRunRequest,
  FleetRunResponse,
  FleetRunResult,
  FleetSkillTarget,
  HealthResponse,
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
  ProbeResult,
  ReconcileResponse,
  ReconcileResult,
  RegistryFinding,
  RegistryRisk,
  RegistrySearchResponse,
  RegistrySearchResult,
  RegistrySearchSort,
  RemoveSkillResponse,
  ResolveSyncConflictsInput,
  ReconcileProblem,
  RepositoryStatus,
  RollbackListResponse,
  RollbackRestoreResponse,
  RollbackResult,
  RuntimeConfig,
  SaveSkillContentResponse,
  SavedSkillContent,
  SettingsPatch,
  SettingsResponse,
  SkillContent,
  SkillContentResponse,
  SkillDiff,
  SkillDiffResponse,
  SkillResponse,
  SkillStatusEntry,
  SkillsResponse,
  StatusResponse,
  SyncConflictDto,
  SyncConnectionDto,
  SyncDisconnectResponse,
  SyncOutcomeDto,
  SyncResponse,
  SyncRollbackDto,
  SyncRollbackFailureDto,
  SyncSnapshotDto,
  SyncSnapshotRestoreResponse,
  SyncSnapshotsResponse,
  SyncStatusResponse,
} from '@skillbox/shared'

/* ------------------------------------------------------------------ *
 * Core service contracts the routes delegate to (server-only)
 * ------------------------------------------------------------------ */

/** Options accepted by the registry search service. */
export interface RegistrySearchOptions {
  provider?: string
  sort?: RegistrySearchSort
  trending?: boolean
  official?: boolean
}

/** Core search service contract (agent 1). */
export interface RegistrySearchService {
  search(query: string, options?: RegistrySearchOptions): Promise<RegistrySearchResult[]>
}

/** Outdated/updates computation service contract (agent 2). */
export interface UpdatesService {
  outdated(): Promise<OutdatedSkill[]>
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
 * V0.4 lifecycle operations (fork / vendor / restore / merge) behind the web
 * API. Every method delegates to the Core transaction
 * (`@skillbox/core/lifecycle` / `merge`); errors keep their Skillbox code so
 * the M10.8 envelope maps them (LIFECYCLE_ILLEGAL_TRANSITION,
 * INTEGRITY_MISMATCH, MERGE_CONFLICT, …).
 */
export interface LifecycleService {
  /** Managed → Forked (M17.1): copy the runtime into the repository. */
  fork(name: string): Promise<LifecycleOperationResult>
  /** Managed/Forked → Vendored (M18): freeze content, drop upstream. */
  vendor(name: string): Promise<LifecycleOperationResult>
  /** Managed → restored upstream (M17.3): re-materialize the pinned revision. */
  restore(name: string): Promise<LifecycleOperationResult>
  /** 3-way merge (M20.6) / `--continue` / `--abort` of one skill. */
  merge(name: string, action: MergeAction): Promise<LifecycleOperationResult>
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
  /** V0.4 lifecycle operations (fork / vendor / restore / merge). */
  lifecycle: LifecycleService
  /** Fleet (multi-host SSH orchestration): reads `.skillbox/fleet.yaml`. */
  fleet: FleetService
  /**
   * Recoverable multi-device sync (connect/sync/conflicts/snapshots). `connect`
   * itself stays CLI-only (it's a multi-minute GitHub device-flow handshake,
   * a poor fit for a single request/response cycle) — the Web surface only
   * covers day-to-day `sync` once a device has already run `skillbox connect`.
   */
  sync: RepositorySync
  /** Absolute repository root the API operates on (identity info). */
  repositoryRoot: string
  /** Absolute Skillbox home root (identity info). */
  homeRoot: string
}

/* ------------------------------------------------------------------ *
 * Server host options (never cross the wire)
 * ------------------------------------------------------------------ */

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
