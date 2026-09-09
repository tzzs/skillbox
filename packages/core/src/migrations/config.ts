import { runtimeConfigSchema, type RuntimeConfig } from '../runtime/config.js'
import { migrateVersionedDocument } from './migrate.js'
import { MigrationRegistry } from './registry.js'
import { CURRENT_CONFIG_VERSION } from './types.js'
import type { MigrationOutcome } from './types.js'

/**
 * Runtime Config migrations. Config files written before versioning had no
 * `version` field; the first registered migration stamps them as v1 (the
 * shape is unchanged, so the migration is lossless).
 */
export const configMigrations = new MigrationRegistry<Record<string, unknown>>([
  {
    from: 0,
    to: 1,
    label: 'config v0 → v1 (add version field)',
    migrate: (document) => ({ ...document, version: 1 }),
  },
])

/**
 * Migrates a raw `config.json` document to the current config version and
 * validates it against the runtime config schema. Unversioned (legacy) files
 * are treated as v0 and stamped v1.
 */
export function migrateConfigDocument(
  raw: Record<string, unknown>,
): MigrationOutcome<RuntimeConfig> {
  return migrateVersionedDocument(raw, configMigrations, CURRENT_CONFIG_VERSION, {
    fileLabel: 'config.json',
    missingVersionAs: 0,
    validate: (document) => {
      const result = runtimeConfigSchema.safeParse(document)
      if (!result.success) {
        throw new Error(result.error.issues.map((issue) => issue.message).join('; '))
      }
      return result.data
    },
  })
}
