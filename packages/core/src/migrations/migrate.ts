import { ErrorCode, SkillboxError } from '../errors.js'
import { MigrationRegistry } from './registry.js'
import type { MigrationOutcome } from './types.js'

/**
 * Migrates one versioned document: reads `version`, refuses documents newer
 * than `currentVersion`, applies the registry migrations up to
 * `currentVersion`, then validates the result with `validate`.
 *
 * `missingVersionAs` maps documents without a `version` field (pre-versioning
 * shapes, e.g. legacy `config.json`) onto a concrete version — used by the
 * config migration; manifest/lockfile readers enforce the integer field
 * themselves.
 */
export function migrateVersionedDocument<Document>(
  raw: Record<string, unknown>,
  registry: MigrationRegistry<unknown>,
  currentVersion: number,
  options: {
    fileLabel: string
    /** Document field holding the version (lockfiles use `lockfileVersion`). */
    versionField?: string
    missingVersionAs?: number
    validate: (document: unknown) => Document
  },
): MigrationOutcome<Document> {
  const versionField = options.versionField ?? 'version'
  const rawVersion = raw[versionField]
  const version =
    typeof rawVersion === 'number' && Number.isInteger(rawVersion)
      ? rawVersion
      : options.missingVersionAs
  if (version === undefined) {
    throw new SkillboxError(
      ErrorCode.INVALID_MANIFEST,
      `${options.fileLabel} must declare an integer "${versionField}"`,
      { context: { path: options.fileLabel, version: rawVersion } },
    )
  }
  if (version > currentVersion) {
    throw new SkillboxError(
      ErrorCode.MIGRATION_FAILED,
      `${options.fileLabel} version ${version} is newer than the supported ${currentVersion}`,
      { context: { path: options.fileLabel, version, current: currentVersion } },
    )
  }
  const outcome = registry.apply(version, currentVersion, raw)
  let document: Document
  try {
    document = options.validate(outcome.document)
  } catch (error) {
    throw new SkillboxError(
      ErrorCode.MIGRATION_FAILED,
      `${options.fileLabel} did not validate after migration`,
      { cause: error, context: { path: options.fileLabel, applied: outcome.applied } },
    )
  }
  return { document, applied: outcome.applied, changed: outcome.changed }
}

/** Type-only re-export so consumers can declare registry types. */
export type { Migration, MigrationOutcome } from './types.js'
