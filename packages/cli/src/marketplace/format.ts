import { renderTable } from '../table.js'
import type {
  AddOutcome,
  InstallStep,
  NormalizedSource,
  OutdatedEntry,
  RegistrySearchResult,
  SecurityScanResult,
  UpdateOutcome,
} from './types.js'

/**
 * V0.3 Marketplace — human-readable rendering for the search / add / outdated
 * / update / cache clean commands. Pure functions so they are trivially
 * testable; the table columns match MVP #125 and #135.
 */

/** Shortens a commit SHA for display without losing comparisons. */
export function shortRevision(revision: string): string {
  return revision.length > 7 ? revision.slice(0, 7) : revision
}

/** `skillbox search` table (MVP #125): NAME / SOURCE / POPULARITY / SECURITY. */
export function renderSearchTable(results: readonly RegistrySearchResult[]): string {
  const rows = results.map((result) => [
    result.name,
    result.source,
    String(result.popularity),
    result.security,
  ])
  return renderTable(['NAME', 'SOURCE', 'POPULARITY', 'SECURITY'], rows)
}

/** `skillbox outdated` table (MVP #135): NAME / INSTALLED / LATEST / STATUS. */
export function renderOutdatedTable(entries: readonly OutdatedEntry[]): string {
  if (entries.length === 0) {
    return '(no managed skills found)'
  }
  const rows = entries.map((entry) => [
    entry.name,
    entry.installed !== undefined ? shortRevision(entry.installed) : '-',
    entry.latest !== undefined ? shortRevision(entry.latest) : '-',
    entry.status,
  ])
  return renderTable(['NAME', 'INSTALLED', 'LATEST', 'STATUS'], rows)
}

/** Security review shown before a remote install (GAP §5 / M21.4). */
export function renderSecurityReview(review: SecurityScanResult): string {
  const files = `${review.filesScanned} file${review.filesScanned === 1 ? '' : 's'}`
  if (review.findings.length === 0) {
    return `Risk: ${review.risk} — no risky patterns found in ${files}.`
  }
  const rows = review.findings.map((finding) => [
    finding.risk,
    finding.name,
    finding.file,
    finding.line !== undefined ? String(finding.line) : '-',
    finding.snippet ?? '',
  ])
  const table = renderTable(['RISK', 'FINDING', 'FILE', 'LINE', 'SNIPPET'], rows)
  const block = review.block ? ' — blocks install without confirmation' : ''
  return `Risk: ${review.risk} — ${review.findings.length} finding(s) in ${files}.${block}\n${table}`
}

/** `skillbox add` summary (manifest/lockfile changes + agent links). */
export function renderAddSummary(outcome: AddOutcome): string {
  if (outcome.cancelled === true) {
    return 'Install cancelled.'
  }
  const lines: string[] = []
  if (outcome.alias !== undefined) {
    lines.push(`Added "${outcome.alias}" from ${outcome.source}`)
  } else {
    lines.push(`Added from ${outcome.source}`)
  }
  if (outcome.revision !== undefined) {
    lines.push(`  revision   ${shortRevision(outcome.revision)}`)
  }
  lines.push(
    `  agents     ${outcome.agents !== undefined && outcome.agents.length > 0 ? outcome.agents.join(', ') : '-'}`,
  )
  lines.push(
    `  manifest   ${outcome.manifestChanged === true ? 'updated' : 'unchanged'}`,
    `  lockfile   ${outcome.lockfileChanged === true ? 'updated' : 'unchanged'}`,
  )
  return lines.join('\n')
}

/** `skillbox update <name>` summary (M16.2: before/after revision). */
export function renderUpdateSummary(outcome: UpdateOutcome): string {
  const from = outcome.fromRevision !== undefined ? shortRevision(outcome.fromRevision) : '-'
  const lines = [`Updated "${outcome.name}": ${from} → ${shortRevision(outcome.toRevision)}`]
  if (outcome.integrity !== undefined) {
    lines.push(`  integrity  ${outcome.integrity}`)
  }
  if (outcome.linkedAgents.length > 0) {
    lines.push(`  agents     ${outcome.linkedAgents.join(', ')} (links preserved)`)
  }
  lines.push(`  lockfile   ${outcome.lockfileChanged === true ? 'updated' : 'unchanged'}`)
  return lines.join('\n')
}

const INSTALL_STEP_LABELS: Record<InstallStep, string> = {
  resolving: 'Resolving',
  downloading: 'Downloading',
  scanning: 'Scanning',
  validating: 'Validating',
  materializing: 'Materializing',
  linking: 'Linking agents',
  'writing-manifest': 'Updating manifest',
  'writing-lockfile': 'Updating lockfile',
}

/** Human label for one install-transaction step. */
export function progressStepLabel(step: InstallStep): string {
  return INSTALL_STEP_LABELS[step] ?? step
}

/** Compact canonical expression of a normalized source (SPEC §23). */
export function formatSource(source: NormalizedSource): string {
  switch (source.type) {
    case 'github':
      return `github:${source.repo}${source.path !== undefined ? `@${source.path}` : ''}`
    case 'skills-sh':
      return source.package
    case 'git': {
      let value = `git:${source.url}`
      if (source.path !== undefined) value += `@${source.path}`
      if (source.ref !== undefined) value += `#${source.ref}`
      return value
    }
    case 'local':
      return source.path
  }
}
