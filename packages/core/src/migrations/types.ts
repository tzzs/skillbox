/**
 * Schema migration framework (roadmap 5.2): deterministic, idempotent,
 * version-by-version document migrations for the Manifest, Lockfile and
 * Runtime Config.
 *
 * A `Migration` rewrites one document from `from` to `to`; the registry
 * applies them in order until the document reaches the current version.
 * Running an up-to-date document is a no-op (`changed: false`), and a
 * version with no registered migration fails with `MIGRATION_MISSING`
 * instead of guessing.
 */

/** One version-bump of a persisted document. */
export interface Migration<Document> {
  /** Version this migration reads. */
  from: number
  /** Version this migration produces. */
  to: number
  /** Human label used in `skillbox migrate` output. */
  label: string
  migrate(document: Document): Document
}

/** Result of running a migration registry over a document. */
export interface MigrationOutcome<Document> {
  document: Document
  /** Labels of the migrations applied, in order. */
  applied: string[]
  /** True when at least one migration ran. */
  changed: boolean
}

export const CURRENT_MANIFEST_VERSION = 1
export const CURRENT_LOCKFILE_VERSION = 1
export const CURRENT_CONFIG_VERSION = 1
