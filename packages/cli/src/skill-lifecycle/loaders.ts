import { SkillboxError, type SkillboxErrorCode } from '@skillbox/core'
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
 * Follows the V0.2 sync (`./sync/loaders.js`) and V0.3 marketplace
 * (`./marketplace/loaders.js`) convention: the CLI defines the contracts in
 * `./types.js` and adapts the core modules onto them at runtime through a
 * dynamic import. When a core export has not landed yet, the call fails with
 * a typed SkillboxError + a recovery hint instead of crashing, so the
 * commands stay safe to run in the meantime.
 *
 * Current mapping onto `@skillbox/core`:
 * - `forkSkill(alias, options)`                  (lifecycle/fork.js — LANDED)
 * - `vendorSkill(alias, options)`                (lifecycle/vendor.js — LANDED)
 * - `detectManagedModifications(alias, options)` (lifecycle/modification.js — LANDED;
 *   returns `boolean`, the CLI contract's `{ modified, files? }` is derived)
 * - `restoreManagedSkill`                        — NOT LANDED (TODO below)
 * - `diffSkill` / `mergeSkill` / `continueMerge` / `abortMerge`
 *                                                — NOT LANDED YET (TODO below)
 */

/** Loads the core package as an opaque module map (injectable in tests). */
export type CoreModuleLoader = () => Promise<Record<string, unknown>>

async function loadSkillboxCore(): Promise<Record<string, unknown>> {
  try {
    return (await import('@skillbox/core')) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * CLI-level error codes until agents 1/2 land matching entries in
 * `@skillbox/core`'s ErrorCode. The casts keep the loader typed; the
 * exit-code mapping (`./exit-codes.js`) is a `Set<string>`, so the codes work
 * before core defines them. TODO(lifecycle): drop the casts once core ships
 * `LIFECYCLE_UNAVAILABLE` / `MERGE_CONFLICT` (or the adapters switch to the
 * codes the core modules actually throw).
 */
const LIFECYCLE_UNAVAILABLE = 'LIFECYCLE_UNAVAILABLE' as SkillboxErrorCode
export const MERGE_CONFLICT_CODE = 'MERGE_CONFLICT' as SkillboxErrorCode
/** CLI-level code thrown while the core lifecycle modules are in flight. */
export const LIFECYCLE_UNAVAILABLE_CODE = LIFECYCLE_UNAVAILABLE

function unavailable(code: SkillboxErrorCode, hint: string): SkillboxError {
  return new SkillboxError(code, hint)
}

/** Options passed to every core lifecycle call; built once per input. */
function coreOptions(input: {
  repositoryRoot: string
  homeRoot?: string
}): Record<string, unknown> {
  const options: Record<string, unknown> = { repositoryRoot: input.repositoryRoot }
  if (input.homeRoot !== undefined) {
    options.homeRoot = input.homeRoot
  }
  return options
}

/* ------------------------------------------------------------------ *
 * Structural result mapping — tolerates both the landed core shapes
 * (`repositoryPath`, `upstream` object, boolean detection) and the CLI
 * contract shapes, so the adapters keep working while agents 1/2 tune
 * their result objects.
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Canonical display form of an upstream source (SPEC §23). */
function formatUpstreamSource(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  const record = asRecord(value)
  if (record === undefined) {
    return undefined
  }
  switch (readString(record, 'type')) {
    case 'github': {
      const repo = readString(record, 'repo')
      if (repo === undefined) {
        return undefined
      }
      const skillPath = readString(record, 'path')
      return `github:${repo}${skillPath !== undefined ? `@${skillPath}` : ''}`
    }
    case 'git':
      return readString(record, 'url')
    case 'registry': {
      const registry = readString(record, 'registry')
      const pkg = readString(record, 'package')
      return registry !== undefined && pkg !== undefined ? `${registry}:${pkg}` : undefined
    }
    case 'local':
      return readString(record, 'path')
    default:
      return undefined
  }
}

function mapForkResult(raw: unknown, name: string): ForkResult {
  const record = asRecord(raw)
  const result: ForkResult = {
    alias: readString(record, 'alias') ?? name,
    mode: 'forked',
    localPath: readString(record, 'repositoryPath') ?? readString(record, 'localPath') ?? '',
    baseRevision: readString(record, 'baseRevision') ?? '',
    // Core transactions always write both files; the contract fields exist
    // for fake providers / future shapes that report partial writes.
    manifestChanged: record?.manifestChanged !== false,
    lockfileChanged: record?.lockfileChanged !== false,
  }
  const upstreamSource = formatUpstreamSource(record?.upstream)
  if (upstreamSource !== undefined) {
    result.upstreamSource = upstreamSource
  }
  const materializedPath = readString(record, 'absolutePath')
  if (materializedPath !== undefined) {
    result.materializedPath = materializedPath
  }
  return result
}

function mapVendorResult(raw: unknown, name: string): VendorResult {
  const record = asRecord(raw)
  return {
    alias: readString(record, 'alias') ?? name,
    mode: 'vendored',
    localPath: readString(record, 'repositoryPath') ?? readString(record, 'localPath') ?? '',
    // Vendoring always drops upstream tracking; `fromFork` (landed core) only
    // says whether a fork existed before.
    upstreamCleared: record?.upstreamCleared !== false,
    manifestChanged: record?.manifestChanged !== false,
    lockfileChanged: record?.lockfileChanged !== false,
  }
}

function mapModifications(raw: unknown, name: string): ManagedModifications {
  if (typeof raw === 'boolean') {
    // Landed core shape: `detectManagedModifications` returns `boolean`.
    return { name, modified: raw }
  }
  const record = asRecord(raw)
  return {
    name,
    modified: record?.modified === true,
    ...(Array.isArray(record?.files) ? { files: record.files as string[] } : {}),
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle provider (agent 1 — @skillbox/core/lifecycle)
 * ------------------------------------------------------------------ */

class LifecycleProviderAdapter implements LifecycleProvider {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(
    private readonly loadCore: CoreModuleLoader,
    private readonly hint: string,
  ) {}

  private async core(): Promise<Record<string, unknown>> {
    this.modulePromise ??= this.loadCore()
    return this.modulePromise
  }

  async forkSkill(input: ForkSkillInput): Promise<ForkResult> {
    const core = await this.core()
    const forkSkill = core.forkSkill as ((name: string, options: unknown) => unknown) | undefined
    if (typeof forkSkill !== 'function') {
      throw unavailable(LIFECYCLE_UNAVAILABLE, this.hint)
    }
    return mapForkResult(await forkSkill(input.name, coreOptions(input)), input.name)
  }

  async vendorSkill(input: VendorSkillInput): Promise<VendorResult> {
    const core = await this.core()
    const vendorSkill = core.vendorSkill as
      ((name: string, options: unknown) => unknown) | undefined
    if (typeof vendorSkill !== 'function') {
      throw unavailable(LIFECYCLE_UNAVAILABLE, this.hint)
    }
    return mapVendorResult(await vendorSkill(input.name, coreOptions(input)), input.name)
  }

  async detectManagedModifications(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ManagedModifications> {
    const core = await this.core()
    const detect = core.detectManagedModifications as
      ((name: string, options: unknown) => unknown) | undefined
    if (typeof detect !== 'function') {
      throw unavailable(LIFECYCLE_UNAVAILABLE, this.hint)
    }
    // Landed core takes `(alias, { repositoryRoot, homeRoot? })` and returns a
    // bare boolean; the CLI contract derives `{ modified, files? }` from it.
    return mapModifications(await detect(input.name, coreOptions(input)), input.name)
  }

  async restoreManagedSkill(input: {
    name: string
    repositoryRoot: string
  }): Promise<RestoreResult> {
    const core = await this.core()
    const restore = core.restoreManagedSkill as
      ((name: string, options: unknown) => unknown) | undefined
    if (typeof restore !== 'function') {
      throw unavailable(
        LIFECYCLE_UNAVAILABLE,
        'Restore is not available in this build yet — the "[Restore]" action of ' +
          '`skillbox edit` lands with the V0.4 lifecycle module. Convert the skill to ' +
          'a fork instead (your local changes are kept), or reinstall the runtime with ' +
          '`skillbox install`.',
      )
    }
    return (await restore(input.name, { repositoryRoot: input.repositoryRoot })) as RestoreResult
  }
}

export function createDefaultLifecycleProvider(
  loadCore: CoreModuleLoader = loadSkillboxCore,
  hint: string = 'The V0.4 lifecycle module is not available in this build yet — ' +
    '`skillbox fork` / `skillbox vendor` / `skillbox edit` land with the lifecycle ' +
    'milestone. Try again after it ships.',
): LifecycleProvider {
  return new LifecycleProviderAdapter(loadCore, hint)
}

/* ------------------------------------------------------------------ *
 * Diff provider (agent 2 — @skillbox/core/diff)
 * ------------------------------------------------------------------ */

class DiffProviderAdapter implements DiffProvider {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(
    private readonly loadCore: CoreModuleLoader,
    private readonly hint: string,
  ) {}

  private async core(): Promise<Record<string, unknown>> {
    this.modulePromise ??= this.loadCore()
    return this.modulePromise
  }

  async diffSkill(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<SkillDiff> {
    const core = await this.core()
    const diffSkill = core.diffSkill as ((name: string, options: unknown) => unknown) | undefined
    if (typeof diffSkill !== 'function') {
      throw unavailable(LIFECYCLE_UNAVAILABLE, this.hint)
    }
    // TODO(diff, agent 2): adapt the mapping onto core's diffSkill signature
    // once it lands (expected `(name, { repositoryRoot, homeRoot })` →
    // `{ name, mode, views: [{ label, files: [{ path, status, patch }] }] }`).
    return (await diffSkill(input.name, coreOptions(input))) as SkillDiff
  }
}

export function createDefaultDiffProvider(
  loadCore: CoreModuleLoader = loadSkillboxCore,
  hint: string = 'The V0.4 diff module is not available in this build yet — ' +
    '`skillbox diff` lands with the diff milestone. Try again after it ships.',
): DiffProvider {
  return new DiffProviderAdapter(loadCore, hint)
}

/* ------------------------------------------------------------------ *
 * Merge provider (agent 2 — @skillbox/core/merge)
 * ------------------------------------------------------------------ */

class MergeProviderAdapter implements MergeProvider {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(
    private readonly loadCore: CoreModuleLoader,
    private readonly hint: string,
  ) {}

  private async core(): Promise<Record<string, unknown>> {
    this.modulePromise ??= this.loadCore()
    return this.modulePromise
  }

  async mergeSkill(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<MergeResult> {
    const core = await this.core()
    const mergeSkill = core.mergeSkill as ((name: string, options: unknown) => unknown) | undefined
    if (typeof mergeSkill !== 'function') {
      throw unavailable(LIFECYCLE_UNAVAILABLE, this.hint)
    }
    // TODO(merge, agent 2): adapt the mapping onto core's mergeSkill signature
    // once it lands (expected `(name, { repositoryRoot, homeRoot })` →
    // `{ name, conflicts: [{ path, hunks, reason? }], filesMerged, changes,
    //   baseRevision? }`).
    return (await mergeSkill(input.name, coreOptions(input))) as MergeResult
  }

  async continueMerge(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ContinueMergeResult> {
    const core = await this.core()
    const continueMerge = core.continueMerge as
      ((name: string, options: unknown) => unknown) | undefined
    if (typeof continueMerge !== 'function') {
      throw unavailable(LIFECYCLE_UNAVAILABLE, this.hint)
    }
    return (await continueMerge(input.name, coreOptions(input))) as ContinueMergeResult
  }

  async abortMerge(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<AbortMergeResult> {
    const core = await this.core()
    const abortMerge = core.abortMerge as ((name: string, options: unknown) => unknown) | undefined
    if (typeof abortMerge !== 'function') {
      throw unavailable(LIFECYCLE_UNAVAILABLE, this.hint)
    }
    return (await abortMerge(input.name, coreOptions(input))) as AbortMergeResult
  }
}

export function createDefaultMergeProvider(
  loadCore: CoreModuleLoader = loadSkillboxCore,
  hint: string = 'The V0.4 merge module is not available in this build yet — ' +
    '`skillbox merge` (and --continue/--abort) land with the merge milestone. ' +
    'Try again after it ships.',
): MergeProvider {
  return new MergeProviderAdapter(loadCore, hint)
}
