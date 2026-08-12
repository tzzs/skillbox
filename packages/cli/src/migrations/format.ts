import type { MigrationResult } from './types.js'

function names(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(', ')
}

/** Stable human rendering for the public migration command. */
export function renderMigrationResult(result: MigrationResult): string {
  return [
    'Migration complete',
    `Applied: ${names(result.applied)}`,
    `Already current: ${names(result.skipped)}`,
  ].join('\n')
}
