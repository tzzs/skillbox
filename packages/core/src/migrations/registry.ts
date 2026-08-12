import { ErrorCode, SkillboxError } from '../errors.js'
import type {
  MigrationDefinition,
  MigrationProgressEvent,
  MigrationRunResult,
  RunMigrationsOptions,
} from './types.js'

/** Ordered registry that executes every not-yet-checkpointed migration exactly once. */
export class MigrationRegistry {
  private readonly migrations: readonly MigrationDefinition[]

  constructor(migrations: readonly MigrationDefinition[]) {
    const ids = new Set<string>()
    for (const migration of migrations) {
      if (migration.id.trim().length === 0) {
        throw new SkillboxError(
          ErrorCode.MIGRATION_INVALID,
          'Migration identifiers cannot be empty',
        )
      }
      if (ids.has(migration.id)) {
        throw new SkillboxError(
          ErrorCode.MIGRATION_INVALID,
          `Migration identifier "${migration.id}" is duplicate`,
        )
      }
      ids.add(migration.id)
    }
    this.migrations = [...migrations]
  }

  list(): readonly MigrationDefinition[] {
    return this.migrations
  }

  async run(options: RunMigrationsOptions): Promise<MigrationRunResult> {
    const completed = new Set(await options.store.listCompleted(options.repositoryRoot))
    const applied: string[] = []
    const skipped: string[] = []
    const now = options.now ?? (() => new Date())

    for (const migration of this.migrations) {
      if (completed.has(migration.id)) {
        skipped.push(migration.id)
        continue
      }
      this.publish(options, now, { phase: 'started', migrationId: migration.id })
      try {
        await migration.run({ repositoryRoot: options.repositoryRoot })
        await options.store.markCompleted(migration.id, options.repositoryRoot)
      } catch (error) {
        this.publish(options, now, {
          phase: 'failed',
          migrationId: migration.id,
          error: { message: error instanceof Error ? error.message : String(error) },
        })
        throw error
      }
      applied.push(migration.id)
      completed.add(migration.id)
      this.publish(options, now, { phase: 'completed', migrationId: migration.id })
    }
    return { applied, skipped }
  }

  private publish(
    options: RunMigrationsOptions,
    now: () => Date,
    event: Omit<MigrationProgressEvent, 'type' | 'repositoryRoot' | 'occurredAt'>,
  ): void {
    options.events?.emit({
      type: 'migration',
      repositoryRoot: options.repositoryRoot,
      occurredAt: now().toISOString(),
      ...event,
    })
  }
}
