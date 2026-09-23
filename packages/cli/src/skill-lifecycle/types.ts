/**
 * V0.4 Skill Lifecycle — CLI-layer contracts for `fork` / `vendor` / `edit` /
 * `diff` / `merge` (GAP_ANALYSIS §4, MVP M17.1-3, M18, M19.4, M20.6-7).
 *
 * Core owns the data shapes and this module imports them — a copy here could
 * only drift, and it already had (a `renamed` diff status core never emits).
 * What stays is what the CLI genuinely owns: the DI contracts `./loaders.js`
 * implements, the flattened request inputs whose fields core takes differently,
 * and the narrowed views the command layer renders — `localPath` is core's
 * `repositoryPath`, `manifestChanged` / `lockfileChanged` are constant `true`
 * because a fork or vendor transaction rewrites both files or rolls the whole
 * run back, and `skillbox diff` only ever sees the two modes that have an
 * upstream.
 */

import type {
  AbortMergeResult,
  ContinueMergeResult,
  MergeSkillConflict,
  MergeSkillResult,
  SkillDiffView,
  SkillFileDiff,
} from '@skillbox/core'

export type { AbortMergeResult, ContinueMergeResult }

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
 * Result of a completed fork — core's `ForkSkillResult` narrowed to what
 * `skillbox fork` renders: the repo-relative path is `localPath`, and a fork
 * transaction rewrites the manifest and lockfile together or rolls back, so
 * those two flags are constants here.
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

/** Result of a completed vendor — core's `VendorSkillResult` as rendered. */
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
 * `restoreManagedSkill` (`@skillbox/core/lifecycle/restore`).
 */
export interface RestoreResult {
  name: string
  /** Number of files restored to the lockfile integrity. */
  filesRestored: number
}

/**
 * Lifecycle provider behind `fork` / `vendor` / `edit`. Each method is adapted
 * from a `@skillbox/core` function by `./loaders.js`; errors core raises
 * (skill not found, no upstream, merge conflict) propagate to the command
 * layer unchanged.
 */
export interface LifecycleProvider {
  forkSkill(input: ForkSkillInput): Promise<ForkResult>
  vendorSkill(input: VendorSkillInput): Promise<VendorResult>
  detectManagedModifications(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ManagedModifications>
  restoreManagedSkill(input: { name: string; repositoryRoot: string }): Promise<RestoreResult>
}

/* ------------------------------------------------------------------ *
 * Diff (@skillbox/core/diff)
 * ------------------------------------------------------------------ */

/**
 * A diff view and its changed files, straight from core. The local copies this
 * replaced declared a `renamed` status core never emits — the renderer prints
 * `status` verbatim, so the extra variant was unreachable rather than a guard.
 */
export type DiffFile = SkillFileDiff
export type DiffView = SkillDiffView

/**
 * Result of `skillbox diff <name>` — core's `SkillDiff` with `mode` narrowed to
 * the two modes that have an upstream. Core types it as the full `SkillMode`
 * and rejects `local` / `vendored` with `DIFF_UPSTREAM_UNAVAILABLE`, which is
 * what makes the narrowing in `./loaders.js` total rather than a hopeful cast.
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
 * Merge (@skillbox/core/merge)
 * ------------------------------------------------------------------ */

/**
 * The merge results, straight from core: they were already field-for-field
 * what `skillbox merge` renders, so the local copies bought nothing, and core
 * even documented them as mirrors of this file. `MergeConflict` / `MergeResult`
 * are this module's names for them.
 */
export type MergeConflict = MergeSkillConflict
export type MergeResult = MergeSkillResult

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
