import * as fs from 'node:fs/promises'
import { resolveInsideRoot } from '../fs/paths.js'

/**
 * Scan primitives shared by the Secret Scanner (`scanFiles`) and the Static
 * Security Scanner (`scanSkillForSecurity`). They live in `secret-scan/`
 * because `security/` already imports from here (`maskSnippet`), so the
 * cross-module edge stays one-directional.
 */

/** Content-size cap for both scanners: larger files are skipped for scanning. */
export const DEFAULT_SCAN_MAX_CONTENT_BYTES = 2 * 1024 * 1024

/**
 * One ascending finding-severity scale for both scanners: the Security Scan
 * rates `low..high`, the Secret Scan adds `critical` on top. Each scanner
 * keeps its own blocking threshold; only the ordering is shared.
 */
export const FINDING_SEVERITY_ORDER = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
} as const

export type FindingSeverityLevel = keyof typeof FINDING_SEVERITY_ORDER

/** Rank of a finding severity; an out-of-catalog label ranks as the lowest. */
export function findingSeverityRank(level: FindingSeverityLevel): number {
  return FINDING_SEVERITY_ORDER[level] ?? 0
}

/** Comparator for "most severe first"; equal ranks return 0. */
export function compareSeverityDesc(
  left: FindingSeverityLevel,
  right: FindingSeverityLevel,
): number {
  return findingSeverityRank(right) - findingSeverityRank(left)
}

/**
 * Reads a file for content scanning; `null` when unreadable, binary (NUL
 * byte) or larger than `maxBytes`.
 */
export async function readScannableContent(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<string | null> {
  const absolute = resolveInsideRoot(root, relativePath)
  let buffer: Buffer
  try {
    buffer = await fs.readFile(absolute)
  } catch {
    return null
  }
  if (buffer.length > maxBytes || buffer.includes(0)) {
    return null
  }
  return buffer.toString('utf8')
}
