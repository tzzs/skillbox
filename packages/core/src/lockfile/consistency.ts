import type { ManifestSkillSource, SkillboxManifest } from '../manifest/schema.js'
import type { SkillboxLockfile } from './schema.js'

/**
 * Read-only comparison of a Manifest against a Lockfile. Never writes to disk;
 * used by `install --frozen-lockfile` / `--ci` to detect a stale lockfile and
 * by the sync pipeline to decide whether the lockfile needs regenerating.
 */
export interface LockfileOutdatedCheck {
  /** True when a locked entry is missing or the locked source disagrees. */
  outdated: boolean
  /** Aliases declared in the Manifest but missing from the Lockfile. */
  missingFromLockfile: string[]
  /** Aliases in the Lockfile but absent from the Manifest (stale entries). */
  staleLockEntries: string[]
  /** Aliases whose locked `source` differs from the Manifest source. */
  mismatchedSources: string[]
}

/** Canonical, order-independent key for a source node (type + string props). */
export function sourceSignature(source: ManifestSkillSource): string {
  const key: Record<string, string> = { type: source.type }
  for (const prop of ['repo', 'url', 'registry', 'package', 'path', 'ref', 'version'] as const) {
    const value = (source as Record<string, unknown>)[prop]
    if (typeof value === 'string') {
      key[prop] = value
    }
  }
  return JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)))
}

/** Compares the Manifest against the Lockfile without touching the filesystem. */
export function compareManifestToLockfile(
  manifest: SkillboxManifest,
  lockfile: SkillboxLockfile,
): LockfileOutdatedCheck {
  const missingFromLockfile: string[] = []
  const mismatchedSources: string[] = []

  for (const [alias, skill] of Object.entries(manifest.skills)) {
    const locked = lockfile.skills[alias]
    if (locked === undefined) {
      missingFromLockfile.push(alias)
      continue
    }
    if (sourceSignature(locked.source) !== sourceSignature(skill.source)) {
      mismatchedSources.push(alias)
    }
  }

  const staleLockEntries = Object.keys(lockfile.skills).filter(
    (alias) => !(alias in manifest.skills),
  )

  return {
    outdated: missingFromLockfile.length > 0 || mismatchedSources.length > 0,
    missingFromLockfile,
    staleLockEntries,
    mismatchedSources,
  }
}
