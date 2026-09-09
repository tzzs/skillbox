/**
 * V0.3 Marketplace — CLI-layer contracts for `search` / `add` / `outdated` /
 * `update` / `cache clean` (GAP_ANALYSIS §3, MVP M14.6 + M16.1-2).
 *
 * The shapes below mirror the types agent 1 (`packages/core/src/registry/`)
 * and agent 2 (`packages/core/src/install/`, `packages/core/src/security/`)
 * landed in `@skillbox/core`. The CLI keeps its own structural copies so
 * this package typechecks while core is under construction; `./loaders.js`
 * adapts the real core exports onto these contracts at runtime — the same
 * pattern the V0.2 sync layer used for git/github/secret-scan.
 */

/** Source types the registry framework can normalize and dispatch on. */
export type RegistrySourceType = 'github' | 'skills-sh' | 'local'

export interface GithubNormalizedSource {
  type: 'github'
  /** GitHub repository in `owner/repo` form. */
  repo: string
  /** Repo-relative skill directory, e.g. `skills/react-best-practices`. */
  path?: string
  /** Resolved branch name when the user pinned one. */
  branch?: string
  /** Raw branch/tag/commit the user pinned, e.g. `main` or `v1.0.0`. */
  ref?: string
}

export interface SkillsShNormalizedSource {
  type: 'skills-sh'
  /** Registry package expression, e.g. `owner/repo@skills/<name>`. */
  package: string
  /** Underlying GitHub repository when the package maps to one. */
  repo?: string
  /** Repo-relative skill directory, when known. */
  path?: string
  /** Version pin when a registry response provides one. */
  version?: string
}

export interface LocalNormalizedSource {
  type: 'local'
  /** Absolute, resolved directory path. */
  path: string
}

/** Generic git remote (GitLab / Bitbucket / self-hosted) — mirrors core types. */
export interface GitNormalizedSource {
  type: 'git'
  /** Clone URL (https / ssh / scp-style). */
  url: string
  /** Repo-relative skill directory inside the checkout. */
  path?: string
  /** Branch / tag / commit pin. */
  ref?: string
}

/**
 * Canonical form of a skill source (SPEC §23) — mirrors agent 1's
 * `NormalizedSource` in `packages/core/src/registry/types.ts`.
 */
export type NormalizedSource =
  GithubNormalizedSource | SkillsShNormalizedSource | GitNormalizedSource | LocalNormalizedSource

/** One search hit from the aggregated registry (skills.sh + GitHub). */
export interface RegistrySearchResult {
  /** Display name of the skill. */
  name: string
  /** Canonical source expression (e.g. `github:org/repo@path`). */
  source: string
  /** Downloads / star count; `0` when the registry does not report one. */
  popularity: number
  /** `'reviewed'` when the registry vouches for the skill, else `'unknown'`. */
  security: 'unknown' | 'reviewed'
  /** Registry description; empty when missing. */
  description: string
}

/** A source pinned to a concrete revision — mirrors core registry/types.ts. */
export interface ResolvedSource {
  /** The same normalized source that was resolved. */
  source: NormalizedSource
  /** Pinned revision (commit SHA for git-backed sources). */
  revision: string
  /** Canonical integrity hash when computable at resolve time. */
  integrity?: string
}

/* ------------------------------------------------------------------ *
 * Security review (agent 2 — packages/core/src/security/types.ts)
 * ------------------------------------------------------------------ */

export type SecurityRiskLevel = 'low' | 'medium' | 'high'

/** One detected risky construct inside a scanned skill. */
export interface SecurityFinding {
  /** Pattern id from the scan catalog, e.g. `shell-exec`. */
  pattern: string
  /** Human-readable pattern name, e.g. `Shell command execution`. */
  name: string
  /** Pattern-level risk rating (the whole-skill risk is the maximum). */
  risk: SecurityRiskLevel
  /** Relative file path, forward slashes on every platform. */
  file: string
  /** 1-based line number; absent for file-level findings. */
  line?: number
  /** Masked line snippet for content findings. */
  snippet?: string
  /** Human-readable remediation suggestion. */
  recommendation: string
}

/** Structured output of a skill scan (M21.3 / SPEC §5). */
export interface SecurityScanResult {
  /** Aggregate rating = the highest risk among all findings. */
  risk: SecurityRiskLevel
  /** Every detected finding, most severe first. */
  findings: SecurityFinding[]
  /** Number of files scanned (including skipped binary/oversized ones). */
  filesScanned: number
  /** True when `risk === 'high'`, which blocks the install by default. */
  block: boolean
}

/** Static security scanner (agent 2 — `@skillbox/core/security`). */
export interface SecurityScanner {
  /** Scans a skill directory and rates it (M21.3). */
  scan(directory: string): Promise<SecurityScanResult>
}

/* ------------------------------------------------------------------ *
 * Core contracts (agent 1 — registry provider framework)
 * ------------------------------------------------------------------ */

/**
 * Parses a user-supplied source string into its canonical form (SPEC §23).
 * Satisfied at runtime by agent 1's `parseSource(source: string)` export.
 */
export interface SourceParser {
  parse(source: string): Promise<NormalizedSource> | NormalizedSource
}

/**
 * Registry provider handling one source type end to end — mirror of agent 1's
 * `RegistryProvider` in `packages/core/src/registry/types.ts`.
 */
export interface RegistryProvider {
  /** Provider id: `github` | `skills-sh` | `local`. */
  id: string
  search(query: string): Promise<RegistrySearchResult[]>
  /** Pins branch/tag to a concrete revision, returning integrity when cheap. */
  resolve(source: NormalizedSource): Promise<ResolvedSource>
  /** Materializes the skill subtree of `source` at `revision` into `targetDir`. */
  download(source: NormalizedSource, revision: string, targetDir: string): Promise<void>
  /** Latest revision for `source` (e.g. default-branch commit SHA). */
  getLatestRevision(source: NormalizedSource): Promise<string>
}

/**
 * Aggregated registry client used by `search` / `add` / `outdated` / `update`.
 * Fan-out across the github + skills-sh providers happens inside the adapter
 * (over `@skillbox/core`'s `defaultRegistry` / `resolveProvider`); the
 * service only sees the merged result.
 */
export interface RegistryClient {
  /** Searches every searchable provider and merges the hits. */
  search(query: string): Promise<RegistrySearchResult[]>
  /** Pins branch/tag to a concrete revision. */
  resolve(source: NormalizedSource): Promise<ResolvedSource>
  /** Latest revision for `source` (e.g. default-branch commit SHA). */
  getLatestRevision(source: NormalizedSource): Promise<string>
  /** The provider handling `source`'s type (used by the add-flow review). */
  providerFor(source: NormalizedSource): Promise<RegistryProvider>
}

/* ------------------------------------------------------------------ *
 * Install transaction (agent 2 — packages/core/src/install)
 * ------------------------------------------------------------------ */

/** Steps of the install pipeline, reported as CLI progress lines. */
export type InstallStep =
  | 'resolving'
  | 'downloading'
  | 'scanning'
  | 'validating'
  | 'materializing'
  | 'linking'
  | 'writing-manifest'
  | 'writing-lockfile'

/**
 * CLI-side install request — maps onto agent 2's `installSkill(source,
 * options)` (core `InstallSkillOptions`). The transaction re-resolves and
 * re-downloads internally (M15.1), so no revision is passed; the CLI's own
 * resolve step only feeds the security review display.
 */
export interface InstallSkillInput {
  /** Already parsed + normalized source (agent 1's parser ran first). */
  source: NormalizedSource
  /** Explicit alias; defaults to the source's name inside the transaction. */
  alias?: string
  /** Agents to link after install. */
  targetAgents?: readonly string[]
  /** Permit a skill whose static scan rated high (M21.4 override). */
  allowHighRisk?: boolean
  /** Provider resolving/downloading the source (required by core). */
  provider?: RegistryProvider
  /** Repository root whose manifest/lockfile gain the entry. */
  repositoryRoot: string
  /** Skillbox home root (defaults to `SKILLBOX_HOME` / `~/.skillbox`). */
  homeRoot?: string
}

/** Outcome of a completed install transaction — mirror of core `InstallResult`. */
export interface InstallResult {
  alias: string
  /** Install transactions always produce managed skills (M15.2). */
  mode: 'managed'
  /** The normalized source that was installed. */
  source: NormalizedSource
  /** Pinned revision installed (commit SHA for git-backed sources). */
  revision: string
  /** Canonical integrity (`sha256:<hex>`) of the installed content. */
  integrity: string
  /** Static scan metadata persisted into the lockfile. */
  security: { risk: SecurityRiskLevel; scannedAt: string }
  /** Agents the skill was linked to. */
  agents: readonly string[]
  /** Absolute path of the materialized skill under the managed library. */
  materializedPath: string
  /** True when the content came from the managed cache (M15.3). */
  cacheHit: boolean
}

/**
 * CLI-side update request for `skillbox update <name>` (M16.2). Satisfied at
 * runtime by `updateSkill` from `@skillbox/core/install`, which preserves the
 * existing agent links (MVP #136) and bumps the lockfile `revision` /
 * `integrity`.
 */
export interface UpdateSkillInput {
  /** Skill alias recorded in the manifest/lockfile. */
  name: string
  /** Normalized source of the installed skill (from the lockfile). */
  source: NormalizedSource
  /** Same HIGH-risk override as {@link InstallSkillInput.allowHighRisk}. */
  allowHighRisk?: boolean
  /** Repository root whose manifest/lockfile gain the entry. */
  repositoryRoot: string
  /** Skillbox home root (defaults to `SKILLBOX_HOME` / `~/.skillbox`). */
  homeRoot?: string
}

/**
 * Remote install transaction (M14.6 / M16.2, GAP_ANALYSIS §3): Resolve →
 * Download (managed cache) → Validate → Integrity → Security → Materialize →
 * Manifest/Lock → Link, with rollback on any failure.
 *
 * Satisfied at runtime by agent 2's `installSkill` / `clearCache` free
 * functions (`updateSkill` pending). `clearCache` returns the number of
 * entries freed so `skillbox cache clean` can report it — core's
 * `clearCache()` returns void, so the loader adapter counts the entries
 * itself before clearing.
 */
export interface InstallService {
  installSkill(input: InstallSkillInput): Promise<InstallResult>
  updateSkill(input: UpdateSkillInput): Promise<void>
  /** Empties the managed cache (`~/.skillbox/cache/`); returns entries freed. */
  clearCache(): Promise<{ cleared: number }>
}

/* ------------------------------------------------------------------ *
 * Command view models
 * ------------------------------------------------------------------ */

/** One row of `skillbox outdated` (M16.1). */
export interface OutdatedEntry {
  name: string
  /** Revision recorded in the lockfile. */
  installed?: string
  /** Latest upstream revision (may be unknown when the check failed). */
  latest?: string
  status: 'up-to-date' | 'outdated' | 'unknown' | 'unsupported'
}

/** Result of `skillbox add` (GAP §5.2 user story). */
export interface AddOutcome {
  /** The source string the user passed. */
  source: string
  /** True when the user cancelled during an interactive prompt. */
  cancelled?: boolean
  alias?: string
  revision?: string
  integrity?: string
  agents?: readonly string[]
  manifestChanged?: boolean
  lockfileChanged?: boolean
}

/** Result of `skillbox update <name>` (M16.2). */
export interface UpdateOutcome {
  name: string
  fromRevision?: string
  toRevision: string
  integrity?: string
  lockfileChanged: boolean
  /** Agent links preserved by the update. */
  linkedAgents: readonly string[]
}

/** Result of `skillbox cache clean`. */
export interface CacheCleanOutcome {
  /** Number of cache entries freed. */
  cleared: number
}
