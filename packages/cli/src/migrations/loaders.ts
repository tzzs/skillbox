import type { MigrationInput, MigrationProvider, MigrationResult } from './types.js'

/** Defensive dynamic loader kept as a stale-build compatibility boundary. */
export type CoreMigrationsLoader = () => Promise<Record<string, unknown>>

async function loadSkillboxCore(): Promise<Record<string, unknown>> {
  try {
    return (await import('@skillbox/core')) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

type Registry = { run(input: { repositoryRoot: string; store: unknown }): Promise<MigrationResult> }
type RegistryConstructor = new (migrations: readonly unknown[]) => Registry
type StoreConstructor = new (options: { homeRoot: string }) => unknown

class CoreMigrationProvider implements MigrationProvider {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(private readonly loadCore: CoreMigrationsLoader) {}

  async migrate(input: MigrationInput): Promise<MigrationResult> {
    this.modulePromise ??= this.loadCore()
    const core = await this.modulePromise
    const RegistryClass = core.MigrationRegistry as RegistryConstructor | undefined
    const StoreClass = core.FilesystemMigrationStore as StoreConstructor | undefined
    if (typeof RegistryClass !== 'function' || typeof StoreClass !== 'function') {
      throw new Error(
        'Schema migration support is not available in this build yet. Update Skillbox and try again.',
      )
    }
    // Released versions register migrations here. An empty registry is meaningful:
    // it still validates the durable state location and reports an up-to-date install.
    const registry = new RegistryClass([])
    return registry.run({
      repositoryRoot: input.repositoryRoot,
      store: new StoreClass({ homeRoot: input.homeRoot }),
    })
  }
}

/** Creates the production CLI adapter over Core migration primitives. */
export function createDefaultMigrationProvider(
  loadCore: CoreMigrationsLoader = loadSkillboxCore,
): MigrationProvider {
  return new CoreMigrationProvider(loadCore)
}
