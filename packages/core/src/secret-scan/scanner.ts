import * as fs from 'node:fs/promises'
import { SkillboxError, ErrorCode } from '../errors.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { compileIgnoreGlob } from '../ignore/glob.js'
import { IgnoreScopes } from '../ignore/scopes.js'
import type { IgnoreMatcher } from '../ignore/skillbox-ignore.js'
import { findingKey, type SecretPolicyStore } from './policy.js'
import {
  CONTENT_SECRET_PATTERNS,
  FILE_SECRET_PATTERNS,
  isBlockingSeverity,
  SEVERITY_RANK,
  type FileSecretPattern,
  type FindingScope,
  type SecretSeverity,
} from './patterns.js'
import type { SecretFinding, ScanResult } from './types.js'

export type { SecretFinding, ScanResult } from './types.js'

export interface ScanFilesOptions {
  /**
   * Absolute root the relative `files` are anchored to. Defaults to the
   * current working directory.
   */
  root?: string
  /**
   * `.skillboxignore` matcher; scan-scoped rules are applied so matching
   * files are skipped entirely.
   */
  ignore?: IgnoreMatcher | null
  /** Policy store; ignored findings/files are excluded and reported. */
  policy?: SecretPolicyStore | null
  /** Content scanning is skipped for files larger than this. Default 2 MiB. */
  maxContentBytes?: number
}

export const DEFAULT_MAX_CONTENT_BYTES = 2 * 1024 * 1024

export interface FileGlobEntry {
  pattern: FileSecretPattern
  regex: RegExp
}

function compileFileGlobs(): FileGlobEntry[] {
  const entries: FileGlobEntry[] = []
  for (const pattern of FILE_SECRET_PATTERNS) {
    for (const glob of pattern.globs) {
      const compiled = compileIgnoreGlob(glob)
      if (compiled !== null) {
        entries.push({ pattern, regex: compiled.regex })
      }
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

async function readScannableContent(
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

export function maskSnippet(line: string, index: number, length: number): string {
  const masked = `${line.slice(0, index)}***${line.slice(index + length)}`.trim()
  return masked.length > 140 ? `${masked.slice(0, 137)}...` : masked
}

interface Candidate {
  file: string
  line?: number
  patternId: string
  name: string
  severity: SecretSeverity
  findingScope: FindingScope
  snippet: string
  recommendation: string
}

function toFinding(candidate: Candidate): SecretFinding {
  const finding: SecretFinding = {
    file: candidate.file,
    patternId: candidate.patternId,
    name: candidate.name,
    severity: candidate.severity,
    scope: candidate.findingScope,
    snippet: candidate.snippet,
    recommendation: candidate.recommendation,
  }
  if (candidate.line !== undefined) {
    finding.line = candidate.line
  }
  return finding
}

/**
 * Scans a list of relative changed files for secrets. File-level patterns
 * are matched against basenames; content patterns are matched line-by-line.
 * `critical` and `high` findings set `result.blocked`. Findings suppressed by
 * `.skillboxignore` (`scan:` scope), the policy (`Ignore once` / `Add to
 * Ignore`) or by binary/oversized content are excluded from the finding
 * lists and reported separately. This is the interface the sync pipeline
 * calls (`scanFiles(changedFiles)`), and its output never feeds Integrity.
 */
export async function scanFiles(
  files: readonly string[],
  options: ScanFilesOptions = {},
): Promise<ScanResult> {
  const root = options.root ?? process.cwd()
  const ignore = options.ignore ?? null
  const policy = options.policy ?? null
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES
  if (policy !== null) {
    await policy.load()
  }

  const fileGlobs = compileFileGlobs()
  const findings: SecretFinding[] = []
  const skippedByPolicy: string[] = []
  const skippedByIgnore: string[] = []

  for (const file of files) {
    const relative = normalizeScannedFile(file)
    if (ignore !== null && ignore.matches(relative, { scope: IgnoreScopes.scan })) {
      skippedByIgnore.push(relative)
      continue
    }
    if (policy !== null && policy.isIgnoredFile(relative)) {
      skippedByPolicy.push(relative)
      continue
    }

    const basename = basenameOf(relative)
    for (const entry of fileGlobs) {
      if (entry.regex.test(basename)) {
        findings.push(
          toFinding({
            file: relative,
            patternId: entry.pattern.id,
            name: entry.pattern.name,
            severity: entry.pattern.severity,
            findingScope: 'file',
            snippet: `File matches "${entry.pattern.id}"`,
            recommendation: entry.pattern.recommendation,
          }),
        )
      }
    }

    const content = await readScannableContent(root, relative, maxContentBytes)
    if (content === null) {
      continue
    }
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      const lineNumber = index + 1
      for (const pattern of CONTENT_SECRET_PATTERNS) {
        const patternMatch = pattern.regex.exec(line)
        if (patternMatch === null) {
          continue
        }
        findings.push(
          toFinding({
            file: relative,
            line: lineNumber,
            patternId: pattern.id,
            name: pattern.name,
            severity: pattern.severity,
            findingScope: 'content',
            snippet: maskSnippet(line, patternMatch.index, patternMatch[0].length),
            recommendation: pattern.recommendation,
          }),
        )
      }
    }
  }

  const kept: SecretFinding[] = []
  for (const finding of findings) {
    const key = findingKey(finding.file, finding.line, finding.patternId)
    if (policy !== null && policy.shouldSkip(key, finding.patternId, finding.file)) {
      skippedByPolicy.push(key)
      continue
    }
    kept.push(finding)
  }

  const blocked = kept
    .filter((finding) => isBlockingSeverity(finding.severity))
    .sort((left, right) => severityCompare(left, right))
  const warnings = kept
    .filter((finding) => finding.severity === 'medium')
    .sort((left, right) => severityCompare(left, right))
  const infos = kept
    .filter((finding) => finding.severity === 'low')
    .sort((left, right) => severityCompare(left, right))

  return {
    filesScanned: files.length,
    findings: kept,
    blocked,
    warnings,
    infos,
    block: blocked.length > 0,
    skippedByPolicy,
    skippedByIgnore,
  }
}

function severityCompare(left: SecretFinding, right: SecretFinding): number {
  return (SEVERITY_RANK[left.severity] ?? 0) - (SEVERITY_RANK[right.severity] ?? 0)
}

/**
 * Typed error the sync pipeline can throw/return when `result.block` is true.
 * Uses the shared `SECRET_FOUND` error code; recoverable so the CLI can offer
 * `Ignore once` / `Add to Ignore`.
 */
export function secretScanBlockedError(findings: ReadonlyArray<SecretFinding>): SkillboxError {
  return new SkillboxError(
    ErrorCode.SECRET_FOUND,
    `Secret scan found ${findings.length} blocking finding(s); resolving required before sync`,
    {
      recoverable: true,
      context: {
        count: findings.length,
        files: [...new Set(findings.map((finding) => finding.file))],
        patternIds: [...new Set(findings.map((finding) => finding.patternId))],
      },
    },
  )
}
