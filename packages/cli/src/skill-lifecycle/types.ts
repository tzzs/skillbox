/**
 * V0.4 Skill Lifecycle — CLI-layer contracts for `fork` / `vendor` / `edit` /
 * `diff` / `merge` (GAP_ANALYSIS §4, MVP M17.1-3, M18, M19.4, M20.6-7).
 *
 * The shapes below mirror the types agent 1 (`packages/core/src/lifecycle/`)
 * and agent 2 (`packages/core/src/diff/`, `packages/core/src/merge/`) are
 * landing in `@skillbox/core`. The CLI keeps its own structural copies so
 * this package typechecks while core is under construction; `./loaders.js`
 * adapts the real core exports onto these contracts at runtime — the same
 * dynamic-import pattern the V0.3 marketplace layer (`./marketplace/loaders.js`)
 * uses.
 */

/* ------------------------------------------------------------------ *
 * Fork / Vendor / Edit (agent 1 — @skillbox/core/lifecycle)
 * ------------------------------------------------------------------ */

/**
 * CLI-side fork request (M17.1). Satisfied at runtime by agent 1's `forkSkill`
 * export: materialize the managed runtime into the repository, snapshot the
 * base revision, and register the skill as `forked` (manifest + lockfile gain
 * a local source and an `upstream` block).
 */
export interface ForkSkillInput {
  /** Skill alias recorded in the manifest/lockfile. */
  name: string
  /** Repository root whose manifest/lockfile gain the entry. */
  repositoryRoot: string
  /** Skillbox home root (defaults to `SKILLBOX_HOME` / `~/.skillbox`). */
  homeRoot?: string
}

/**
 * Result of a completed fork — mirror of agent 1's `ForkSkillResult`.
 * Rendering tolerates missing optional fields until the core result lands.
 */
export interface ForkResult {
  /** Skill alias (unchanged by the fork). */
  alias: string
  mode: 'forked'
  /** Repo-relative path of the forked copy (the manifest source path). */
  localPath: string
  /** Canonical upstream source expression the fork tracks (SPEC §23). */
  upstreamSource?: string
  /** Revision the fork is based on (upstream base revision). */
  baseRevision: string
  /** Absolute path of the fork's runtime under the repository. */
  materializedPath?: string
  manifestChanged: boolean
  lockfileChanged: boolean
}

/**
 * CLI-side vendor request (M18). Satisfied at runtime by agent 1's
 * `vendorSkill`: copy the runtime into the repository and drop the upstream
 * tracking (`managed`/`forked` → `vendored`).
 */
export interface VendorSkillInput {
  name: string
  repositoryRoot: string
  homeRoot?: string
}

/** Result of a completed vendor — mirror of agent 1's `VendorSkillResult`. */
export interface VendorResult {
  alias: string
  mode: 'vendored'
  /** Repo-relative path of the vendored copy. */
  localPath: string
  /** True when the upstream tracking was cleared. */
  upstreamCleared: boolean
  manifestChanged: boolean
  lockfileChanged: boolean
}

/**
 * Local-modification detection for a managed skill (M17.2). Satisfied at
 * runtime by agent 1's `detectManagedModifications`: compares the materialized
 * runtime against the lockfile integrity.
 */
export interface ManagedModifications {
  name: string
  /** True when the on-disk runtime differs from the lockfile integrity. */
  modified: boolean
  /** Changed file paths relative to the skill root (when core reports them). */
  files?: readonly string[]
}

/**
 * Restore of a modified managed runtime from the lockfile integrity
 * (M17.3 "[Restore]"). Satisfied at runtime by agent 1's
 * `restoreManagedSkill` — restores the pinned, verified managed cache entry.
 */
export interface RestoreResult {
  name: string
  /** Number of files restored to the lockfile integrity. */
  filesRestored: number
}

/**
 * Lifecycle provider (agent 1) behind `fork` / `vendor` / `edit`. Each method
 * is adapted from a `@skillbox/core` free function by `./loaders.js`; when the
 * export has not landed, the adapter throws a typed error + recovery hint.
 */
export interface LifecycleProvider {
  forkSkill(input: ForkSkillInput): Promise<ForkResult>
  vendorSkill(input: VendorSkillInput): Promise<VendorResult>
  detectManagedModifications(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ManagedModifications>
  restoreManagedSkill(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<RestoreResult>
}

/* ------------------------------------------------------------------ *
 * Diff (agent 2 — @skillbox/core/diff)
 * ------------------------------------------------------------------ */

/** One changed file inside a diff view (M19.4). */
export interface DiffFile {
  /** Repo-relative path, forward slashes on every platform. */
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** Unified-diff body for this file (may span multiple lines). */
  patch: string
}

/** One comparison of a skill, e.g. `Current vs Latest` or `Local`. */
export interface DiffView {
  /** Display label; the CLI renders it as a section header. */
  label: string
  files: DiffFile[]
}

/**
 * Result of `skillbox diff <name>` — mirror of agent 2's `diffSkill`:
 * managed skills compare the current runtime vs the latest upstream revision;
 * forked skills get three views (Base / Local / Upstream).
 */
export interface SkillDiff {
  name: string
  mode: 'managed' | 'forked'
  views: DiffView[]
  /** True when every view has no files — the "No changes" case. */
  unchanged: boolean
}

/**
 * Diff provider (agent 2) behind `skillbox diff`. Satisfied at runtime by
 * agent 2's `diffSkill` export from `@skillbox/core/diff`.
 */
export interface DiffProvider {
  diffSkill(input: { name: string; repositoryRoot: string; homeRoot?: string }): Promise<SkillDiff>
}

/* ------------------------------------------------------------------ *
 * Merge (agent 2 — @skillbox/core/merge)
 * ------------------------------------------------------------------ */

/** One conflicting file of a 3-way merge (M20). */
export interface MergeConflict {
  /** Repo-relative path, forward slashes on every platform. */
  path: string
  /** Number of conflict hunks in this file. */
  hunks: number
  /** e.g. `binary` when the file was not auto-merged. */
  reason?: string
}

/** Result of a 3-way merge run — mirror of agent 2's `mergeSkill`. */
export interface MergeResult {
  name: string
  conflicts: MergeConflict[]
  filesMerged: number
  changes: number
  /** New base revision after a clean merge (upstream revision absorbed). */
  baseRevision?: string
}

/** Result of `--continue` — mirror of agent 2's `continueMerge`. */
export interface ContinueMergeResult {
  name: string
  /** True when every conflict was resolved and the metadata was updated. */
  resolved: boolean
  remainingConflicts: MergeConflict[]
  filesMerged: number
  changes: number
  baseRevision?: string
}

/** Result of `--abort` — mirror of agent 2's `abortMerge`. */
export interface AbortMergeResult {
  name: string
  filesRestored: number
}

/**
 * Merge provider (agent 2) behind `skillbox merge`. Satisfied at runtime by
 * agent 2's `mergeSkill` / `continueMerge` / `abortMerge` exports from
 * `@skillbox/core/merge`.
 */
export interface MergeProvider {
  mergeSkill(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<MergeResult>
  continueMerge(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ContinueMergeResult>
  abortMerge(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<AbortMergeResult>
}

/* ------------------------------------------------------------------ *
 * Command view models
 * ------------------------------------------------------------------ */

/** Outcome of `skillbox fork <name>` (M17.1). */
export interface ForkOutcome extends ForkResult {
  /** Mode before the fork (`managed`). */
  fromMode: 'managed'
}

/** Outcome of `skillbox vendor <name>` (M18). */
export interface VendorOutcome extends VendorResult {
  /** Mode before the vendor (`managed` or `forked`). */
  fromMode: 'managed' | 'forked'
}

/** What `skillbox edit <name>` did before (or instead of) opening the editor. */
export type EditAction = 'edited' | 'forked' | 'restored' | 'cancelled' | 'deferred'

/** Outcome of `skillbox edit <name>` (M17.2/17.3). */
export interface EditOutcome {
  name: string
  action: EditAction
  /** SKILL.md path offered to the editor (when known). */
  path?: string
  /** Fork base revision when the edit converted the skill. */
  baseRevision?: string
}

/** Outcome of a successful `skillbox merge` / `--continue` / `--abort`. */
export type MergeOutcome =
  | {
      kind: 'merged'
      name: string
      filesMerged: number
      changes: number
      /** Updated base revision after a clean merge. */
      baseRevision?: string
    }
  | {
      kind: 'continued'
      name: string
      filesMerged: number
      changes: number
      baseRevision?: string
    }
  | { kind: 'aborted'; name: string; filesRestored: number }

/** CLI-side merge request. */
export interface MergeInput {
  name: string
  /** `merge` runs the 3-way merge; `continue`/`abort` manage an in-flight one. */
  action: 'merge' | 'continue' | 'abort'
}
