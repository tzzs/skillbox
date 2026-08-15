import { skillboxLockfileSchema, type SkillboxLockfile } from '../lockfile/schema.js'
import { migrateVersionedDocument } from './migrate.js'
import { MigrationRegistry } from './registry.js'
import { CURRENT_LOCKFILE_VERSION } from './types.js'
import type { MigrationOutcome } from './types.js'

/**
 * Lockfile migrations. v1 is the first published lockfile schema, so the
 * registry is empty — documents older than v1 fail with `MIGRATION_MISSING`
 * until a migration is registered (see `migrateVersionedDocument`).
 */
export const lockfileMigrations = new MigrationRegistry<Record<string, unknown>>([])

/** Migrates a raw `skillbox.lock` document to the current lockfile version. */
export function migrateLockfileDocument(
  raw: Record<string, unknown>,
): MigrationOutcome<SkillboxLockfile> {
  return migrateVersionedDocument(raw, lockfileMigrations, CURRENT_LOCKFILE_VERSION, {
    fileLabel: 'skillbox.lock',
    versionField: 'lockfileVersion',
    validate: (document) => skillboxLockfileSchema.parse(document),
  })
}
