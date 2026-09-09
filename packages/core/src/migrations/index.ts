import { parse as parseYaml } from 'yaml'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { writeManifest } from '../manifest/index.js'
import { writeLockfile } from '../lockfile/index.js'
import { serializeRuntimeConfig } from '../runtime/config.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { migrateConfigDocument } from './config.js'
import { migrateLockfileDocument } from './lockfile.js'
import { migrateManifestDocument } from './manifest.js'
import type { MigrationOutcome } from './types.js'

export { MigrationRegistry } from './registry.js'
export { migrateVersionedDocument } from './migrate.js'
export { configMigrations, migrateConfigDocument } from './config.js'
export { manifestMigrations, migrateManifestDocument } from './manifest.js'
export { lockfileMigrations, migrateLockfileDocument } from './lockfile.js'
export {
  CURRENT_CONFIG_VERSION,
  CURRENT_LOCKFILE_VERSION,
  CURRENT_MANIFEST_VERSION,
  type Migration,
  type MigrationOutcome,
} from './types.js'

/** One file's migration report, rendered by `skillbox migrate`. */
export interface MigrateFileReport {
  path: string
  /** False when the file does not exist (nothing to migrate). */
  present: boolean
  /** True when a migration ran and the file was rewritten. */
  changed: boolean
  /** Labels of the applied migrations, in order. */
  applied: string[]
}

export interface MigrateRepositoryReport {
  config: MigrateFileReport
  manifest: MigrateFileReport
  lockfile: MigrateFileReport
}

async function migrateFile<Document>(
  filePath: string,
  filesystem: FilesystemService,
  read: (content: string) => unknown,
  migrateAndPersist: (raw: Record<string, unknown>) => Promise<MigrationOutcome<Document>>,
): Promise<MigrateFileReport> {
  if (!(await filesystem.exists(filePath))) {
    return { path: filePath, present: false, changed: false, applied: [] }
  }
  const raw = read(await filesystem.readFile(filePath)) as Record<string, unknown>
  const outcome = await migrateAndPersist(raw)
  return { path: filePath, present: true, changed: outcome.changed, applied: outcome.applied }
}

/**
 * Migrates the repository's `skillbox.yaml` / `skillbox.lock` and the
 * machine's `config.json` to the current schema versions, persisting any
 * change. Up-to-date files are reported as `changed: false` (idempotent).
 * A version with no registered migration fails with `MIGRATION_MISSING`
 * instead of guessing.
 */
export async function migrateRepository(
  repositoryRoot: string,
  options: { homeRoot?: string; filesystem?: FilesystemService } = {},
): Promise<MigrateRepositoryReport> {
  const filesystem = options.filesystem ?? new FilesystemService()
  const layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())

  const config = await migrateFile(
    layout.configFile,
    filesystem,
    (content) => JSON.parse(content),
    async (raw) => {
      const outcome = migrateConfigDocument(raw)
      if (outcome.changed) {
        await atomicWriteFile(layout.configFile, serializeRuntimeConfig(outcome.document))
      }
      return outcome
    },
  )

  const manifestPath = `${repositoryRoot}/skillbox.yaml`
  const manifest = await migrateFile(
    manifestPath,
    filesystem,
    (content) => parseYaml(content),
    async (raw) => {
      const outcome = migrateManifestDocument(raw)
      if (outcome.changed) {
        await writeManifest(repositoryRoot, outcome.document)
      }
      return outcome
    },
  )

  const lockfilePath = `${repositoryRoot}/skillbox.lock`
  const lockfile = await migrateFile(
    lockfilePath,
    filesystem,
    (content) => parseYaml(content),
    async (raw) => {
      const outcome = migrateLockfileDocument(raw)
      if (outcome.changed) {
        await writeLockfile(repositoryRoot, outcome.document)
      }
      return outcome
    },
  )

  return { config, manifest, lockfile }
}
