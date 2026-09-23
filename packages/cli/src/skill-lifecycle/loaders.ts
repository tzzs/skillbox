import {
  abortMerge,
  continueMerge,
  detectManagedModifications,
  diffSkill,
  ErrorCode,
  forkSkill,
  mergeSkill,
  restoreManagedSkill,
  SkillboxError,
  vendorSkill,
  type ForkSkillResult,
  type ManifestSkillSource,
  type RestoreManagedSkillResult,
  type SkillMode,
  type SkillboxErrorCode,
  type VendorSkillResult,
} from '@skillbox/core'
import type {
  AbortMergeResult,
  ContinueMergeResult,
  DiffProvider,
  ForkResult,
  ForkSkillInput,
  LifecycleProvider,
  ManagedModifications,
  MergeProvider,
  MergeResult,
  RestoreResult,
  SkillDiff,
  VendorResult,
  VendorSkillInput,
} from './types.js'

/**
 * V0.4 Skill Lifecycle — default provider loaders (CLI layer).
 *
 * The CLI defines the contracts in `./types.js`; the adapters below call the
 * `@skillbox/core` exports through their real, statically imported signatures.
 * Core and CLI ship in the same build, so a renamed or dropped export is a
 * compile failure here rather than a runtime "this build is missing the
 * lifecycle export" guess — and the only errors these adapters raise are the
 * ones core throws, which propagate unchanged.
 *
 * Each factory takes a `deps` object with one field per core function it
 * calls, defaulting to the real core functions: production (`../program.js`)
 * calls them with no arguments, focused tests pass fakes that return real core
 * result shapes.
 *
 * Current mapping onto `@skillbox/core`:
 * - `forkSkill(alias, options)`                  (lifecycle/fork.js)
 * - `vendorSkill(alias, options)`                (lifecycle/vendor.js)
 * - `detectManagedModifications(alias, options)` (lifecycle/modification.js;
 *   returns `boolean`, the CLI contract's `{ name, modified }` is derived)
 * - `restoreManagedSkill(alias, options)`        (lifecycle/restore.js)
 * - `diffSkill` / `mergeSkill` / `continueMerge` / `abortMerge`
 *                                                (diff/ and merge/)
 */

/**
 * CLI-level error codes: core's ErrorCode defines neither of them, and the
 * exit-code mapping (`../exit-codes.js`) is a `Set<string>`, so the cast keeps
 * them typed. TODO(lifecycle): drop the casts once core ships
 * `LIFECYCLE_UNAVAILABLE` / `MERGE_CONFLICT`.
 */
export const MERGE_CONFLICT_CODE = 'MERGE_CONFLICT' as SkillboxErrorCode
/** Code the service layer wraps non-Skillbox lifecycle failures in. */
export const LIFECYCLE_UNAVAILABLE_CODE = 'LIFECYCLE_UNAVAILABLE' as SkillboxErrorCode

/** Options built once per input and handed to every core call. */
function coreOptions(input: { repositoryRoot: string; homeRoot?: string }): {
  repositoryRoot: string
  homeRoot?: string
} {
  return {
    repositoryRoot: input.repositoryRoot,
    ...(input.homeRoot !== undefined ? { homeRoot: input.homeRoot } : {}),
  }
}

/* ------------------------------------------------------------------ *
 * Result mapping — core's landed shapes onto the CLI contracts
 * ------------------------------------------------------------------ */

/**
 * Canonical display form of an upstream source (SPEC §23). The exhaustive
 * switch over core's source union keeps every variant's string form in one
 * place: a new source type in core is a compile error here.
 */
function formatUpstreamSource(source: ManifestSkillSource): string {
  switch (source.type) {
    case 'github':
      return source.path !== undefined
        ? `github:${source.repo}@${source.path}`
        : `github:${source.repo}`
    case 'git':
      return source.url
    case 'registry':
      return `${source.registry}:${source.package}`
    case 'local':
      return source.path
  }
}

function mapForkResult(result: ForkSkillResult): ForkResult {
  return {
    alias: result.alias,
    mode: 'forked',
    localPath: result.repositoryPath,
    upstreamSource: formatUpstreamSource(result.upstream),
    baseRevision: result.baseRevision,
    materializedPath: result.absolutePath,
    // A fork transaction rewrites both files or rolls the whole run back.
    manifestChanged: true,
    lockfileChanged: true,
  }
}

function mapVendorResult(result: VendorSkillResult): VendorResult {
  return {
    alias: result.alias,
    mode: 'vendored',
    localPath: result.repositoryPath,
    // Vendoring always drops the upstream block from manifest + lockfile;
    // `fromFork` only reports whether the skill was a fork before.
    upstreamCleared: true,
    manifestChanged: true,
    lockfileChanged: true,
  }
}

function mapRestoreResult(result: RestoreManagedSkillResult): RestoreResult {
  return { name: result.alias, filesRestored: result.filesRestored }
}

/**
 * The modes `diffSkill` builds views for. Core types the result mode as the
 * full `SkillMode` but rejects `local`/`vendored` with
 * DIFF_UPSTREAM_UNAVAILABLE before returning; the CLI contract carries only
 * the two diffable modes.
 */
function mapDiffMode(mode: SkillMode): 'managed' | 'forked' {
  switch (mode) {
    case 'managed':
    case 'forked':
      return mode
    case 'local':
    case 'vendored':
      throw new SkillboxError(
        ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
        `Skill mode "${mode}" has no upstream to diff`,
      )
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle provider — @skillbox/core/lifecycle
 * ------------------------------------------------------------------ */

/** Core lifecycle functions the provider calls; replaceable in tests. */
export interface LifecycleCoreDeps {
  forkSkill: typeof forkSkill
  vendorSkill: typeof vendorSkill
  detectManagedModifications: typeof detectManagedModifications
  restoreManagedSkill: typeof restoreManagedSkill
}

const defaultLifecycleCore: LifecycleCoreDeps = {
  forkSkill,
  vendorSkill,
  detectManagedModifications,
  restoreManagedSkill,
}

class LifecycleProviderAdapter implements LifecycleProvider {
  constructor(private readonly deps: LifecycleCoreDeps) {}

  async forkSkill(input: ForkSkillInput): Promise<ForkResult> {
    return mapForkResult(await this.deps.forkSkill(input.name, coreOptions(input)))
  }

  async vendorSkill(input: VendorSkillInput): Promise<VendorResult> {
    return mapVendorResult(await this.deps.vendorSkill(input.name, coreOptions(input)))
  }

  async detectManagedModifications(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ManagedModifications> {
    // Core reports a bare boolean; the CLI contract names the skill with it.
    const modified = await this.deps.detectManagedModifications(input.name, coreOptions(input))
    return { name: input.name, modified }
  }

  async restoreManagedSkill(input: {
    name: string
    repositoryRoot: string
  }): Promise<RestoreResult> {
    return mapRestoreResult(await this.deps.restoreManagedSkill(input.name, coreOptions(input)))
  }
}

export function createDefaultLifecycleProvider(
  deps: LifecycleCoreDeps = defaultLifecycleCore,
): LifecycleProvider {
  return new LifecycleProviderAdapter(deps)
}

/* ------------------------------------------------------------------ *
 * Diff provider — @skillbox/core/diff
 * ------------------------------------------------------------------ */

/** Core diff functions the provider calls; replaceable in tests. */
export interface DiffCoreDeps {
  diffSkill: typeof diffSkill
}

const defaultDiffCore: DiffCoreDeps = { diffSkill }

class DiffProviderAdapter implements DiffProvider {
  constructor(private readonly deps: DiffCoreDeps) {}

  async diffSkill(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<SkillDiff> {
    const diff = await this.deps.diffSkill(input.name, coreOptions(input))
    return {
      name: diff.name,
      mode: mapDiffMode(diff.mode),
      views: diff.views,
      unchanged: diff.unchanged,
    }
  }
}

export function createDefaultDiffProvider(deps: DiffCoreDeps = defaultDiffCore): DiffProvider {
  return new DiffProviderAdapter(deps)
}

/* ------------------------------------------------------------------ *
 * Merge provider — @skillbox/core/merge
 * ------------------------------------------------------------------ */

/** Core merge functions the provider calls; replaceable in tests. */
export interface MergeCoreDeps {
  mergeSkill: typeof mergeSkill
  continueMerge: typeof continueMerge
  abortMerge: typeof abortMerge
}

const defaultMergeCore: MergeCoreDeps = { mergeSkill, continueMerge, abortMerge }

/**
 * The merge contracts *are* core's types now (M20.6/7), so this adapter only
 * builds the option object.
 */
class MergeProviderAdapter implements MergeProvider {
  constructor(private readonly deps: MergeCoreDeps) {}

  mergeSkill(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<MergeResult> {
    return this.deps.mergeSkill(input.name, coreOptions(input))
  }

  continueMerge(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ContinueMergeResult> {
    return this.deps.continueMerge(input.name, coreOptions(input))
  }

  abortMerge(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<AbortMergeResult> {
    return this.deps.abortMerge(input.name, coreOptions(input))
  }
}

export function createDefaultMergeProvider(deps: MergeCoreDeps = defaultMergeCore): MergeProvider {
  return new MergeProviderAdapter(deps)
}
