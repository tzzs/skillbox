/**
 * Risk rating the Static Security Scanner (M21.3 / SPEC §5) assigns to a skill.
 * `high` blocks a remote install by default (M21.4); `medium` and `low` only
 * warn. Records stay backward-compatible with the lockfile schema contract.
 */
export type SecurityRiskLevel = 'low' | 'medium' | 'high'

/** Lower rank means a higher risk; used to aggregate a whole-skill rating. */
export const SECURITY_RISK_RANK: Record<SecurityRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

export type SecurityFindingScope = 'content' | 'file'

/** One detected risky construct inside a scanned skill. */
export interface SecurityFinding {
  /** Pattern id from the scan catalog, e.g. `shell-exec`. */
  pattern: string
  /** Human-readable pattern name, e.g. `Shell command execution`. */
  name: string
  /** Pattern-level risk rating (the whole-skill risk is the maximum). */
  risk: SecurityRiskLevel
  /** Relative file path, forward slashes on every platform. */
  file: string
  /** 1-based line number; absent for file-level findings. */
  line?: number
  /** Masked line snippet for content findings. */
  snippet?: string
  /** Human-readable remediation suggestion. */
  recommendation: string
}

/** Structured output of a skill scan. */
export interface SecurityScanResult {
  /** Aggregate rating = the highest risk among all findings (`low` when clean). */
  risk: SecurityRiskLevel
  /** Every detected finding, most severe first. */
  findings: SecurityFinding[]
  /** Number of files scanned (including skipped binary/oversized ones). */
  filesScanned: number
  /** True when `risk === 'high'`, which blocks the install by default. */
  block: boolean
}

/** Persisted summary written to the Lockfile (SPEC §117). */
export interface SecurityMetadata {
  risk: SecurityRiskLevel
  /** ISO-8601 UTC timestamp of the scan. */
  scannedAt: string
}
