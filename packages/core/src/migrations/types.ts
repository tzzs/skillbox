import type { EventPublisher } from '../events/types.js'

/** Durable checkpoint boundary for migrations. Implemented by a repository or home-state store. */
export interface MigrationStore {
  listCompleted(repositoryRoot: string): Promise<readonly string[]>
  markCompleted(id: string, repositoryRoot: string): Promise<void>
}

/** Context available to each migration. It intentionally exposes no filesystem implementation details. */
export interface MigrationContext {
  repositoryRoot: string
}

/** One idempotent, versioned upgrade step. IDs remain stable once released. */
export interface MigrationDefinition {
  id: string
  description?: string
  run(context: MigrationContext): Promise<void>
}

export type MigrationProgressPhase = 'started' | 'completed' | 'failed'

/** Serializable lifecycle event consumable by CLI, web, TUI, and business logging sinks. */
export interface MigrationProgressEvent {
  type: 'migration'
  phase: MigrationProgressPhase
  migrationId: string
  repositoryRoot: string
  occurredAt: string
  error?: { message: string }
}

export interface RunMigrationsOptions {
  repositoryRoot: string
  store: MigrationStore
  events?: EventPublisher<MigrationProgressEvent>
  now?: () => Date
}

export interface MigrationRunResult {
  applied: readonly string[]
  skipped: readonly string[]
}
