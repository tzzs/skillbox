export interface MigrationInput {
  repositoryRoot: string
  homeRoot: string
}

export interface MigrationResult {
  applied: readonly string[]
  skipped: readonly string[]
}

/** Injectable public boundary behind `skillbox migrate`. */
export interface MigrationProvider {
  migrate(input: MigrationInput): Promise<MigrationResult>
}
