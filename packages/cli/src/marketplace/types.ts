/**
 * V0.3 Marketplace — CLI-layer contracts for `search` / `add` / `outdated` /
 * `update` / `cache clean` (GAP_ANALYSIS §3, MVP M14.6 + M16.1-2).
 *
 * Core's *data* shapes are imported from `@skillbox/core` and re-exported here
 * instead of being copied. This module used to keep structural copies "while
 * core is under construction"; core is built now, and a copy can only drift —
 * core could rename or add a field and the CLI would keep typechecking against
 * a description of an object that no longer exists. Importing turns that drift
 * into a compile error at the seam (`./loaders.js`), which is the point.
 *
 * What stays local is what the CLI genuinely owns: the dependency-injection
 * contracts its adapters implement (`SourceParser`, `RegistryClient`,
 * `InstallService`, `SecurityScanner`), the CLI-side request inputs
 * (`InstallSkillInput`, `UpdateSkillInput`) whose fields core takes differently,
 * and the command view models rendered by `./format.js`.
 */

import type {
  InstallResult,
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
  SecurityScanResult,
} from '@skillbox/core'

/* ------------------------------------------------------------------ *
 * Core shapes — stated once, in core, and reused here
 * ------------------------------------------------------------------ */

/**
 * Canonical skill sources (SPEC §23) and the registry results built on them:
 * `RegistrySourceType`, the four `*NormalizedSource` variants,
 * `NormalizedSource`, `RegistrySearchResult`, `ResolvedSource`.
 */
export type {
  GithubNormalizedSource,
  GitNormalizedSource,
  LocalNormalizedSource,
  NormalizedSource,
  RegistrySourceType,
  ResolvedSource,
  RegistrySearchResult,
  SkillsShNormalizedSource,
} from '@skillbox/core'

/** Static security scanner output (agent 2 — M21.3 / SPEC §5). */
export type { SecurityFinding, SecurityRiskLevel, SecurityScanResult } from '@skillbox/core'

/** Registry provider framework (agent 1) and the install transaction result. */
export type { InstallResult, RegistryProvider } from '@skillbox/core'

/* ------------------------------------------------------------------ *
 * Dependency-injection contracts (CLI-owned; implemented by ./loaders.js)
 * ------------------------------------------------------------------ */

/**
 * Parses a user-supplied source string into core's canonical form (SPEC §23).
 * Satisfied at runtime by core's `parseSource(source: string)` export.
 */
export interface SourceParser {
  parse(source: string): Promise<NormalizedSource> | NormalizedSource
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

/** Static security scanner (agent 2 — `@skillbox/core/security`). */
export interface SecurityScanner {
  /** Scans a skill directory and rates it (M21.3). */
  scan(directory: string): Promise<SecurityScanResult>
}

/* ------------------------------------------------------------------ *
 * Install transaction inputs (CLI-owned request shapes)
 * ------------------------------------------------------------------ */

/**
 * Steps of the install pipeline, reported as CLI progress lines. Core exposes
 * no step vocabulary (the transaction logs nothing), so this is CLI-only.
 */
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
 * CLI-side install request — maps onto core's `installSkill(source, options)`
 * (core `InstallSkillOptions`). The shapes differ on purpose: core takes
 * `source` as the positional argument, nests the risk override in
 * `allowPolicy.allowHighRisk`, and keeps its `agentRegistry` / `filesystem`
 * seams out of the CLI's hand. The transaction re-resolves and re-downloads
 * internally (M15.1), so no revision is passed; the CLI's own resolve step only
 * feeds the security review display.
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

/**
 * CLI-side update request for `skillbox update <name>` (M16.2). Satisfied at
 * runtime by `updateSkill` from `@skillbox/core/install`, which preserves the
 * existing agent links (MVP #136) and bumps the lockfile `revision` /
 * `integrity`. Like {@link InstallSkillInput}, this is the CLI's flattened
 * request shape: core's `UpdateSkillOptions` takes `source` positionally, calls
 * the alias `alias`, and nests the risk override in `allowPolicy`.
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
 * Satisfied at runtime by core's `installSkill` / `updateSkill` / `clearCache`
 * free functions. `clearCache` returns the number of entries freed so
 * `skillbox cache clean` can report it — core's `clearCache()` returns void, so
 * the loader adapter counts the entries itself before clearing.
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
