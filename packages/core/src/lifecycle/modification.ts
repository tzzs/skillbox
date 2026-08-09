import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { ErrorCode, isSkillboxError, SkillboxError } from '../errors.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { deriveMode, readManifest, validateSkillAlias } from '../manifest/index.js'
import { readLockfile } from '../lockfile/index.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { forkSkill } from './fork.js'
import type { ForkSkillResult, LifecycleOptions } from './types.js'

/** Options for modification detection (same shape as the base lifecycle options). */
export type ManagedModificationDetectionOptions = LifecycleOptions

/**
 * M17.3 External Modification Detection: compares the managed runtime copy
 * (`~/.skillbox/library/managed/<alias>`) against the integrity recorded in
 * `skillbox.lock`. Returns `true` when the runtime copy diverged (edited
 * outside Skillbox), `false` when it still matches — or when the skill is not
 * managed at all, has no locked entry, or has no runtime copy (nothing to
 * compare). Throws `SKILL_NOT_FOUND` for unknown skills.
 */
export async function detectManagedModifications(
  aliasInput: string,
  options: ManagedModificationDetectionOptions,
): Promise<boolean> {
  const alias = validateSkillAlias(aliasInput)
  const filesystem = options.filesystem ?? new FilesystemService()
  const layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())
  const library = new RuntimeLibraryService(layout.library, filesystem)
  const repositoryRoot = path.resolve(options.repositoryRoot)

  const manifest = await readManifest(repositoryRoot)
  const entry = manifest.skills[alias]
  if (entry === undefined) {
    throw new SkillboxError(ErrorCode.SKILL_NOT_FOUND, `Skill "${alias}" is not in the manifest`, {
      context: { alias },
    })
  }
  if (deriveMode(entry) !== 'managed') {
    return false
  }

  let locked
  try {
    locked = (await readLockfile(repositoryRoot)).skills[alias]
  } catch (error) {
    if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
      return false
    }
    throw error
  }
  if (locked?.integrity === undefined) {
    return false
  }

  const managedPath = library.pathFor(alias, 'managed')
  if (!(await filesystem.exists(managedPath))) {
    return false
  }
  const current = await computeSkillIntegrity(managedPath)
  return current !== locked.integrity
}

export interface EnsureForkBeforeEditOptions extends ManagedModificationDetectionOptions {
  /**
   * When the managed copy was modified and `autoConvert` is `true`, convert
   * Managed → Forked automatically and return the fork result. When `false`
   * (default), throw `LIFECYCLE_MANAGED_MODIFIED` instead so the CLI can
   * present the "[Convert to Fork] / [Restore Upstream]" choice (SPEC §92-93).
   */
  autoConvert?: boolean
}

/**
 * Decision primitive for the CLI edit flow (SPEC §92-93): ensures the skill is
 * safe to edit by converting (or offering to convert) a modified Managed
 * skill into a Fork.
 *
 * Returns:
 * - `null` — no conversion needed: the skill is already forked/local/vendored,
 *   or it is managed and its runtime copy still matches the lockfile.
 * - `ForkSkillResult` — the Managed → Forked conversion that just ran
 *   (only with `autoConvert: true`).
 *
 * Throws:
 * - `SKILL_NOT_FOUND` for unknown skills
 * - `LIFECYCLE_MANAGED_MODIFIED` (recoverable) when the managed copy diverged
 *   from the lockfile and `autoConvert` is `false`.
 */
export async function ensureForkBeforeEdit(
  alias: string,
  options: EnsureForkBeforeEditOptions,
): Promise<ForkSkillResult | null> {
  if (!(await detectManagedModifications(alias, options))) {
    return null
  }
  if (options.autoConvert === true) {
    return forkSkill(alias, options)
  }
  throw new SkillboxError(
    ErrorCode.LIFECYCLE_MANAGED_MODIFIED,
    `Managed skill "${alias}" was modified outside Skillbox; convert it to a fork or restore the upstream copy before editing`,
    { recoverable: true, context: { alias } },
  )
}
