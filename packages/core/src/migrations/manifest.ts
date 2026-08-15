import { skillboxManifestSchema, type SkillboxManifest } from '../manifest/schema.js'
import { migrateVersionedDocument } from './migrate.js'
import { MigrationRegistry } from './registry.js'
import { CURRENT_MANIFEST_VERSION } from './types.js'
import type { MigrationOutcome } from './types.js'

/**
 * Manifest migrations. v1 is the first published manifest schema, so the
 * registry is empty — documents older than v1 fail with `MIGRATION_MISSING`
 * until a migration is registered (see `migrateVersionedDocument`).
 */
export const manifestMigrations = new MigrationRegistry<Record<string, unknown>>([])

/** Migrates a raw `skillbox.yaml` document to the current manifest version. */
export function migrateManifestDocument(
  raw: Record<string, unknown>,
): MigrationOutcome<SkillboxManifest> {
  return migrateVersionedDocument(raw, manifestMigrations, CURRENT_MANIFEST_VERSION, {
    fileLabel: 'skillbox.yaml',
    validate: (document) => skillboxManifestSchema.parse(document),
  })
}
