import { ErrorCode, SkillboxError } from '../errors.js'
import type { Migration, MigrationOutcome } from './types.js'

/**
 * Ordered migration registry: applies `from → from+1 → … → targetVersion`
 * with no branching, so the outcome is deterministic and idempotent
 * (re-running an already-migrated document is a no-op).
 */
export class MigrationRegistry<Document> {
  constructor(private readonly migrations: readonly Migration<Document>[] = []) {}

  /** Human labels of every registered migration (for `skillbox migrate`). */
  labels(): string[] {
    return this.migrations.map((migration) => migration.label)
  }

  /**
   * Migrates `document` from `currentVersion` to `targetVersion`.
   *
   * Throws:
   * - `MIGRATION_MISSING` when a version has no registered migration
   * - `MIGRATION_FAILED` when a migration produces a non-consecutive version
   */
  apply(
    currentVersion: number,
    targetVersion: number,
    document: Document,
  ): MigrationOutcome<Document> {
    let version = currentVersion
    let current = document
    const applied: string[] = []
    while (version < targetVersion) {
      const next = this.migrations.find((migration) => migration.from === version)
      if (next === undefined) {
        throw new SkillboxError(
          ErrorCode.MIGRATION_MISSING,
          `No migration registered from version ${version} to ${version + 1}`,
          { context: { from: version, to: targetVersion, registered: this.labels() } },
        )
      }
      if (next.to <= version) {
        throw new SkillboxError(
          ErrorCode.MIGRATION_FAILED,
          `Migration "${next.label}" must bump the version forward (${next.from} → ${next.to})`,
          { context: { label: next.label, from: next.from, to: next.to } },
        )
      }
      current = next.migrate(current)
      applied.push(next.label)
      version = next.to
    }
    return { document: current, applied, changed: applied.length > 0 }
  }
}
