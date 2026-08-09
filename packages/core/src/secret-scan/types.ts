import type { FindingScope, SecretSeverity } from './patterns.js'

export interface SecretFinding {
  /** Relative repo path, forward slashes on every platform. */
  file: string
  /** 1-based line number; absent for file-level findings. */
  line?: number
  /** Pattern id from the scan catalog, e.g. `github-pat`. */
  patternId: string
  /** Human-readable pattern name, e.g. `GitHub personal access token`. */
  name: string
  severity: SecretSeverity
  /** `file` for filename matches, `content` for line-level regex matches. */
  scope: FindingScope
  /** Masked snippet — never contains the real secret. */
  snippet: string
  /** Human-readable remediation suggestion. */
  recommendation: string
}

/**
 * Structured output of `scanFiles`. `critical` and `high` findings land in
 * `blocked`; when that array is non-empty `block` tells the sync pipeline to
 * refuse the commit/sync. `medium` findings are `warnings`, `low` are
 * `infos`. Findings silenced by `.skillboxignore` or the secret policy are
 * NOT included in the finding lists — their origins are reported in
 * `skippedByIgnore` / `skippedByPolicy`.
 */
export interface ScanResult {
  /** Number of input files scanned (including skipped ones). */
  filesScanned: number
  /** Every finding that survived ignore and policy filtering. */
  findings: SecretFinding[]
  /** critical + high findings, most severe first. */
  blocked: SecretFinding[]
  /** medium findings, most severe first. */
  warnings: SecretFinding[]
  /** low findings, most severe first. */
  infos: SecretFinding[]
  /** True when commit/sync must be blocked (blocked.length > 0). */
  block: boolean
  /** File paths skipped because they matched `.skillboxignore` (scan scope). */
  skippedByIgnore: string[]
  /** Finding keys/files skipped because of the secret policy. */
  skippedByPolicy: string[]
}
