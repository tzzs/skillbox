/**
 * The Web JSON API contract — declared once, consumed twice.
 *
 * `packages/cli/src/web` implements this API and `apps/web/src/api.ts` calls it.
 * Before this module existed both sides hand-wrote their own copy of every
 * shape, and they had already drifted once (the UI's `ConflictChoice` listed six
 * sync resolutions while Core's `ConflictResolution` — the only three the engine
 * can carry out — defined what the server accepts). A contract with two
 * definitions has no way to notice that class of bug: the wire stays valid
 * JSON, the server answers with a value the client's type says is impossible,
 * and nothing on either side fails until a user clicks.
 *
 * Rules of this module:
 *  - **Types only.** No runtime code lives here, so neither side gains a
 *    build-time dependency on the other through it.
 *  - The server decides the shape. Where Core's domain type is what the route
 *    actually serializes, it is re-exported rather than described again.
 *  - Names are the server's. `apps/web` keeps its historical names by aliasing
 *    these at import time (type-only, so still one definition).
 */

import type {
  AdoptReport,
  AgentAssignmentResult,
  AgentRegistry,
  BackupRecord,
  CleanupStep,
  ConflictResolution,
  ConflictType,
  CreateSkillResult,
  DoctorReport,
  FleetHostConfig,
  FleetOperationName,
  FleetRunResult,
  FleetSkillTarget,
  LinkStrategy,
  ReconcileResult,
  RemoveSkillResult,
  RepositoryStatus,
  RollbackResult,
  RuntimeConfig,
  SkillDiff,
  SkillService,
} from '@skillbox/core'

/* ------------------------------------------------------------------ *
 * Core domain shapes that cross the wire verbatim
 * ------------------------------------------------------------------ */

export type {
  AdoptReport,
  AgentAssignmentResult,
  AgentCapabilities,
  AgentDetectionSummary,
  BackupRecord,
  CleanupStep,
  ConflictResolution,
  ConflictType,
  CreateSkillResult,
  DoctorReport,
  FleetHostConfig,
  FleetHostResult,
  FleetOperationName,
  FleetRunResult,
  FleetSkillTarget,
  LinkStrategy,
  ProbeResult,
  ReconcileProblem,
  ReconcileResult,
  RemoveSkillResult,
  RepositoryStatus,
  RollbackResult,
  RuntimeConfig,
  SkillDiff,
  SkillDiffView,
  SkillFileDiff,
  SkillMode,
  SkillStatus,
  SkillStatusEntry,
  SyncBlocker,
} from '@skillbox/core'

/** Personal library (`<home>/personal`) behaviour, as stored in the Config. */
export type LibrarySettings = NonNullable<RuntimeConfig['library']>

/* ------------------------------------------------------------------ *
 * Skill content endpoints (`/api/skills/:id/content`, `POST /api/skills`)
 * ------------------------------------------------------------------ *
 * Spelled from the Core service methods the routes delegate to, so a change to
 * what the server returns is a change here and nowhere else.
 */

/** `GET /api/skills/:id/content` payload. */
export type SkillContent = Awaited<ReturnType<SkillService['readSkillMarkdown']>>

/** `PUT /api/skills/:id/content` payload: the fresh integrity after a write. */
export type SavedSkillContent = Awaited<ReturnType<SkillService['writeSkillMarkdown']>>

/** `POST /api/skills` payload. */
export type CreatedSkill = CreateSkillResult

/** Body of `POST /api/skills`. */
export interface CreateSkillInput {
  name: string
  description?: string
}

/* ------------------------------------------------------------------ *
 * V0.3 registry API (M14.7 Explore / M15 install / M16.3 updates)
 * ------------------------------------------------------------------ */

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

/** Sort orders `GET /api/registry/search` accepts. */
export type RegistrySearchSort = 'popularity' | 'recently-updated'

/** Query parameters of `GET /api/registry/search`. */
export interface RegistrySearchParams {
  /** Omit it (or send it empty) for a bare browse: Trending / Official / sort-only. */
  q?: string
  provider?: string
  sort?: RegistrySearchSort
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

/* ------------------------------------------------------------------ *
 * V0.4 lifecycle API (M17 fork/vendor/restore, M20 merge)
 * ------------------------------------------------------------------ */

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

/** Action accepted by `POST /api/skills/:id/merge`. */
export type MergeAction = 'merge' | 'continue' | 'abort'

/* ------------------------------------------------------------------ *
 * Settings (`GET`/`PUT` /api/settings)
 * ------------------------------------------------------------------ */

/**
 * The editable subset of the Machine Config accepted by `PUT /api/settings`;
 * everything else in `RuntimeConfig` (repository path, GitHub block, schema
 * version) is read-only over HTTP and survives a patch untouched.
 *
 * An agent override carries a `path` (a non-empty string sets it; an empty
 * string removes the override) — `executable` is deliberately not editable
 * here, matching the server's validator.
 */
export interface SettingsPatch {
  linkStrategy?: LinkStrategy
  web?: { port?: number; host?: string; open?: boolean }
  agents?: Record<string, { path?: string; skillDirectories?: string[] }>
  library?: LibrarySettings
}

/* ------------------------------------------------------------------ *
 * Fleet API (multi-host SSH orchestration)
 * ------------------------------------------------------------------ */

/** Body of `POST /api/fleet/hosts` — a complete host record. */
export type FleetHostCreateRequest = FleetHostConfig

/**
 * Body of `PATCH /api/fleet/hosts/:name` — every field replaces the current
 * value; `name` renames the host.
 */
export type FleetHostPatchRequest = Partial<FleetHostConfig>

/** Body of `POST /api/fleet/run`: named/tagged config hosts, plus ad-hoc `--ssh`-style entries. */
export interface FleetRunRequest {
  /**
   * Every operation the route accepts, taken from Core's `FleetOperationName`
   * — `ping` included, which an earlier copy of this type left out even though
   * the UI had a Ping button and the server answered it.
   */
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

/* ------------------------------------------------------------------ *
 * Multi-device sync (`RepositorySync`) DTOs
 * ------------------------------------------------------------------ *
 * `connect`/`disconnect` stay CLI-only (the GitHub device-flow handshake takes
 * minutes and does not fit a request/response cycle); these DTOs cover
 * day-to-day sync once a device has already run `skillbox connect`.
 */

/** One conflict of a sync session, in its presented (preview) form. */
export interface SyncConflictDto {
  id: string
  /** Conflict kind as Core classifies it — the UI renders a per-kind prompt. */
  type: ConflictType
  skillAlias?: string
  path?: string
  field?: string
  basePreview?: string
  localPreview?: string
  remotePreview?: string
  allowedResolutions: ConflictResolution[]
  recommendedResolution?: ConflictResolution
  destructive: boolean
}

/** One open conflict session. */
export interface ConflictSessionDto {
  id: string
  createdAt: string
  expiresAt: string
  snapshotId: string
  conflicts: SyncConflictDto[]
}

/** The three states a sync can end in, flattened from Core's `SyncOutcome`. */
export type SyncOutcomeDto =
  | { kind: 'completed'; automaticallyMerged: number; retriedPushes: number; snapshotId?: string }
  | { kind: 'conflicts'; sessionId: string; conflictCount: number; snapshotId: string }
  | { kind: 'blocked'; reason: string; message: string; retryable: boolean; snapshotId?: string }

/** GitHub connection snapshot — read-only, never starts a device flow. */
export interface SyncConnectionDto {
  connected: boolean
  login?: string
  repository?: string
}

/** Body of `POST /api/conflicts/:id/resolve`. */
export interface ResolveSyncConflictsInput {
  /** Conflict id -> the resolution chosen for it. */
  resolutions: Record<string, ConflictResolution>
}

/** One row of `GET /api/sync/snapshots` — a restorable sync checkpoint. */
export interface SyncSnapshotDto {
  id: string
  createdAt: string
  expiresAt: string
  /** Short (8-char) pre-sync commit the checkpoint restores toward. */
  revision: string
  expired: boolean
}

/**
 * One sync cleanup step that failed while the transaction was rolling itself back
 * (GAP §4.6). Wire copy of Core's `CleanupFailure`; see {@link SyncRollbackDto}
 * for why the shape is copied field by field instead of being imported.
 */
export interface SyncRollbackFailureDto {
  /** Which recovery step failed; the names come from Core's `CleanupStep` union. */
  step: CleanupStep
  /**
   * Restore-point id or temporary-tree path the step was working on. A server
   * path, and deliberately the *only* path this envelope exposes — it is already
   * in `message`, which every surface prints.
   */
  target: string
  /** Deepest reason from the failure's `cause` chain, secret-scrubbed server-side. */
  message: string
  /**
   * True only for `restore`: the working tree was left mid-transaction, which is
   * the fact a UI should surface. A false leak is clutter the next sync ignores.
   */
  blocking: boolean
}

/**
 * The rollback report a failed sync transaction attaches to the error it rethrows
 * (Core `RollbackReport`), exposed as data so the client can branch on
 * `restoreFailed` instead of string-parsing `message`.
 *
 * This is the *only* part of `error.context` the API exports, and it is copied
 * field by field rather than serialized wholesale: contexts across Core carry git
 * command lines with embedded credentials, repository paths and full
 * stdout/stderr dumps (see `git/git-client.ts`, and the fact that log output has
 * to pass through `logging/redact.ts` to be safe at all). Anything else Core
 * starts putting in a context stays out of the response until it is whitelisted
 * here on purpose — the *whitelisting* itself is behaviour and lives in
 * `packages/cli/src/web/errors.ts`.
 */
export interface SyncRollbackDto {
  /** Restore point the transaction tried to roll back to. */
  snapshotId: string
  /** True when the pre-transaction working tree is still unrestored. */
  restoreFailed: boolean
  failures: SyncRollbackFailureDto[]
}

/* ------------------------------------------------------------------ *
 * Error envelope (M10.8)
 * ------------------------------------------------------------------ */

/** Unified error envelope required by M10.8. */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    recoverable: boolean
    /**
     * Present only when a failed sync transaction could not finish rolling itself
     * back. Optional by design: `code`/`message`/`recoverable` are what every
     * existing consumer reads, and the key is omitted (never `null`) otherwise.
     */
    rollback?: SyncRollbackDto
  }
}

/* ------------------------------------------------------------------ *
 * Response envelopes — one per route, so the client never re-types a body
 * ------------------------------------------------------------------ */

/** Success shape of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok'
  name: string
  version: string
  repository: string
  home: string
}

/** Success shape of `GET /api/status` — Core's report, verbatim. */
export type StatusResponse = RepositoryStatus

/** Success shape of `GET /api/skills`. */
export interface SkillsResponse {
  skills: RepositoryStatus['skills']
}

/** Success shape of `GET /api/skills/:id`. */
export interface SkillResponse {
  skill: RepositoryStatus['skills'][number]
}

/** Success shape of `GET /api/skills/:id/content`. */
export interface SkillContentResponse {
  skill: SkillContent
}

/** Success shape of `POST /api/skills`. */
export interface CreateSkillResponse {
  created: CreatedSkill
}

/** Success shape of `PUT /api/skills/:id/content`. */
export interface SaveSkillContentResponse {
  saved: SavedSkillContent
}

/** Success shape of `DELETE /api/skills/:id`. */
export interface RemoveSkillResponse {
  removed: RemoveSkillResult
}

/** Success shape of `POST /api/skills/:id/enable` and `/disable`. */
export interface AgentAssignmentResponse {
  assignment: AgentAssignmentResult
}

/** Success shape of `GET /api/agents`. */
export interface AgentsResponse {
  agents: Awaited<ReturnType<AgentRegistry['detectAll']>>
}

/** Success shape of `POST /api/reconcile`. */
export interface ReconcileResponse {
  reconcile: ReconcileResult
}

/** Success shape of `POST /api/library/adopt` (V0.5 personal library). */
export interface AdoptResponse {
  report: AdoptReport
}

/** Success shape of `GET /api/settings` / `PUT /api/settings`. */
export interface SettingsResponse {
  settings: RuntimeConfig
}

/** Success shape of `GET /api/doctor`. */
export interface DoctorResponse {
  report: DoctorReport
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

/** Success shape of `POST /api/skills/:id/{fork,vendor,restore,merge}`. */
export interface LifecycleResultResponse {
  result: LifecycleOperationResult
}

/** Success shape of `GET /api/rollbacks` (roadmap 2.4). */
export interface RollbackListResponse {
  rollbacks: BackupRecord[]
}

/** Success shape of `POST /api/rollbacks/:id/restore` (roadmap 2.4). */
export interface RollbackRestoreResponse {
  rollback: RollbackResult
}

/** Success shape of `GET /api/fleet/hosts`. */
export interface FleetHostsResponse {
  hosts: FleetHostConfig[]
}

/** Success shape of `POST /api/fleet/hosts` and `PATCH /api/fleet/hosts/:name`. */
export interface FleetHostResponse {
  host: FleetHostConfig
}

/** Success shape of `DELETE /api/fleet/hosts/:name`. */
export interface FleetHostRemoveResponse {
  removed: true
}

/** Success shape of `POST /api/fleet/run`. */
export interface FleetRunResponse {
  result: FleetRunResult
}

/** Success shape of `GET /api/sync/status` (idle when there's no open conflict session). */
export interface SyncStatusResponse {
  sync: { kind: 'idle' } | SyncOutcomeDto
  connection: SyncConnectionDto
}

/** Success shape of `POST /api/sync` and `POST /api/conflicts/:id/resolve`. */
export interface SyncResponse {
  sync: SyncOutcomeDto
}

/** Success shape of `POST /api/sync/disconnect`. */
export interface SyncDisconnectResponse {
  disconnected: true
}

/** Success shape of `GET /api/conflicts`. */
export interface ConflictsResponse {
  conflicts: ConflictSessionDto[]
}

/** Success shape of `GET /api/conflicts/:id`. */
export interface ConflictResponse {
  conflict: ConflictSessionDto
}

/** Success shape of `GET /api/sync/snapshots`. */
export interface SyncSnapshotsResponse {
  snapshots: SyncSnapshotDto[]
}

/** Success shape of `POST /api/sync/snapshots/:id/restore`. */
export interface SyncSnapshotRestoreResponse {
  restored: true
}
