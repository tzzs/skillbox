/** Workflows a `.skillboxignore` rule can be scoped to (SPEC §106-109). */
export const IgnoreScopes = {
  /** Import existing skills: matching files are not imported. */
  import: 'import',
  /** Sync: matching files are never pushed/distributed to the repository. */
  sync: 'sync',
  /** Secret scan: matching files are skipped while scanning. */
  scan: 'scan',
  /** Backup: matching files are not included in backups. */
  backup: 'backup',
} as const

export type IgnoreScope = (typeof IgnoreScopes)[keyof typeof IgnoreScopes]

export const ALL_IGNORE_SCOPES: readonly IgnoreScope[] = Object.freeze([
  IgnoreScopes.import,
  IgnoreScopes.sync,
  IgnoreScopes.scan,
  IgnoreScopes.backup,
])

const IGNORE_SCOPE_SET: ReadonlySet<string> = new Set(ALL_IGNORE_SCOPES)

export function isIgnoreScope(value: string): value is IgnoreScope {
  return IGNORE_SCOPE_SET.has(value)
}
