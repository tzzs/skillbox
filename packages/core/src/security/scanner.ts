import { scanDirectory } from '../fs/scanner.js'
import type { IgnoreMatcher } from '../ignore/skillbox-ignore.js'
import { maskSnippet } from '../secret-scan/scanner.js'
import {
  DEFAULT_SCAN_MAX_CONTENT_BYTES,
  compareSeverityDesc,
  findingSeverityRank,
  readScannableContent,
} from '../secret-scan/scan-primitives.js'
import {
  CONTENT_SECURITY_PATTERNS,
  FILE_SECURITY_PATTERNS,
  type FileSecurityPattern,
} from './patterns.js'
import { type SecurityFinding, type SecurityRiskLevel, type SecurityScanResult } from './types.js'

export interface ScanSkillDirectoryOptions {
  /**
   * `.skillboxignore` matcher; matching files are skipped entirely (same
   * convention as the Secret Scanner and the Integrity hash).
   */
  ignore?: IgnoreMatcher | null
  /** Content scanning is skipped for files larger than this. Default 2 MiB. */
  maxContentBytes?: number
}

interface FileGlobEntry {
  pattern: FileSecurityPattern
  regex: RegExp
}

function compileFileGlobs(): FileGlobEntry[] {
  const entries: FileGlobEntry[] = []
  for (const pattern of FILE_SECURITY_PATTERNS) {
    for (const glob of pattern.globs) {
      const regex = new RegExp(
        `^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`,
        'i',
      )
      entries.push({ pattern, regex })
    }
  }
  return entries
}

function normalizeScannedFile(file: string): string {
  let normalized = file.replace(/\\/g, '/')
  normalized = normalized.replace(/\/{2,}/g, '/')
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  return normalized
}

function basenameOf(relativePath: string): string {
  const segments = relativePath.split('/')
  return segments[segments.length - 1] ?? relativePath
}

function aggregateRisk(findings: readonly SecurityFinding[]): SecurityRiskLevel {
  let worst: SecurityRiskLevel = 'low'
  for (const finding of findings) {
    if (findingSeverityRank(finding.risk) > findingSeverityRank(worst)) {
      worst = finding.risk
    }
  }
  return worst
}

function byRiskThenLocation(left: SecurityFinding, right: SecurityFinding): number {
  const riskDelta = compareSeverityDesc(left.risk, right.risk)
  if (riskDelta !== 0) {
    return riskDelta
  }
  const fileDelta = left.file.localeCompare(right.file)
  if (fileDelta !== 0) {
    return fileDelta
  }
  return (left.line ?? 0) - (right.line ?? 0)
}

/**
 * M15.1 Security step: static scan of a skill directory before install.
 *
 * File-level patterns match risky basenames (`*.sh`, `*.ps1`, ...); content
 * patterns run line-by-line over every text file and flag shell execution
 * (exec/spawn/child_process, curl|bash), network access (fetch/http), file
 * writes / destructive removal (fs.writeFile, rm -rf, Remove-Item) and
 * credential access (env tokens/passwords, ssh keys, secrets managers).
 *
 * The aggregate `risk` is the highest finding rating (`low` when clean);
 * `block` is true for `high` risk, which the Install Transaction rejects by
 * default (`allowPolicy` can override). Binary and oversized files are
 * skipped for content scanning but still counted in `filesScanned`.
 *
 * Named `scanSkillForSecurity` to avoid colliding with the fs scanner's
 * `scanSkillDirectory` (which lists skill directories).
 */
export async function scanSkillForSecurity(
  skillRoot: string,
  options: ScanSkillDirectoryOptions = {},
): Promise<SecurityScanResult> {
  const ignore = options.ignore ?? null
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_SCAN_MAX_CONTENT_BYTES

  const scan = await scanDirectory(skillRoot, ignore === null ? {} : { ignore })
  // Git internals are scanner noise when the scan root is a raw clone:
  // sample hooks trip network/exec patterns but are never skill content.
  const files = scan.files.filter((file) => !/^\.git\//.test(normalizeScannedFile(file)))
  const fileGlobs = compileFileGlobs()
  const findings: SecurityFinding[] = []

  for (const file of files) {
    const relative = normalizeScannedFile(file)
    const basename = basenameOf(relative)

    for (const entry of fileGlobs) {
      if (entry.regex.test(basename)) {
        findings.push({
          pattern: entry.pattern.id,
          name: entry.pattern.name,
          risk: entry.pattern.risk,
          file: relative,
          recommendation: entry.pattern.recommendation,
        })
      }
    }

    const content = await readScannableContent(skillRoot, relative, maxContentBytes)
    if (content === null) {
      continue
    }
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      for (const pattern of CONTENT_SECURITY_PATTERNS) {
        const match = pattern.regex.exec(line)
        if (match === null) {
          continue
        }
        findings.push({
          pattern: pattern.id,
          name: pattern.name,
          risk: pattern.risk,
          file: relative,
          line: index + 1,
          snippet: maskSnippet(line, match.index, match[0].length),
          recommendation: pattern.recommendation,
        })
      }
    }
  }

  findings.sort(byRiskThenLocation)
  const risk = aggregateRisk(findings)
  return {
    risk,
    findings,
    filesScanned: files.length,
    block: risk === 'high',
  }
}
