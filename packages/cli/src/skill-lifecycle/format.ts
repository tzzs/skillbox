import type { EditOutcome, ForkOutcome, MergeOutcome, SkillDiff, VendorOutcome } from './types.js'

/**
 * V0.4 Skill Lifecycle — human-readable rendering for the fork / vendor /
 * edit / diff / merge commands. Pure functions so they are trivially
 * testable; blocks follow the marketplace formatting conventions.
 */

/** `skillbox fork` summary (M17.1): alias / mode / upstream / baseRevision. */
export function renderForkSummary(outcome: ForkOutcome): string {
  const lines = [`Forked "${outcome.alias}" (${outcome.fromMode} → forked)`]
  if (outcome.baseRevision !== '') {
    lines.push(`  base revision  ${outcome.baseRevision}`)
  }
  if (outcome.upstreamSource !== undefined && outcome.upstreamSource !== '') {
    lines.push(`  upstream       ${outcome.upstreamSource}`)
  }
  lines.push(
    `  manifest       ${outcome.manifestChanged ? 'updated' : 'unchanged'}`,
    `  lockfile       ${outcome.lockfileChanged ? 'updated' : 'unchanged'}`,
  )
  return lines.join('\n')
}

/** `skillbox vendor` summary (M18): mode → vendored, upstream cleared. */
export function renderVendorSummary(outcome: VendorOutcome): string {
  const lines = [`Vendored "${outcome.alias}" (${outcome.fromMode} → vendored)`]
  if (outcome.localPath !== '') {
    lines.push(`  path           ${outcome.localPath}`)
  }
  lines.push(
    `  upstream       ${outcome.upstreamCleared ? 'cleared' : 'unchanged'}`,
    `  manifest       ${outcome.manifestChanged ? 'updated' : 'unchanged'}`,
    `  lockfile       ${outcome.lockfileChanged ? 'updated' : 'unchanged'}`,
  )
  return lines.join('\n')
}

/** `skillbox edit` summary (M17.2/17.3). */
export function renderEditSummary(outcome: EditOutcome): string {
  switch (outcome.action) {
    case 'forked':
      return `Converted "${outcome.name}" to a fork (managed → forked) — opening SKILL.md.`
    case 'restored':
      return `Restored "${outcome.name}" from the lockfile integrity — pristine again.`
    case 'cancelled':
      return 'Edit cancelled — no changes made.'
    case 'deferred':
      return (
        `Edit deferred — no changes made.\n` +
        `Run \`skillbox edit ${outcome.name} --yes\` to convert "${outcome.name}" to a fork and edit it.`
      )
    case 'edited':
      return `Opened "${outcome.name}" in your editor.`
  }
}

/**
 * `skillbox diff` output (M19.4): managed → a single `Current vs Latest`
 * view; forked → Base / Local / Upstream blocks. No differences at all
 * render as "No changes".
 */
export function renderDiff(diff: SkillDiff): string {
  if (diff.unchanged) {
    return `No changes for "${diff.name}".`
  }
  const lines: string[] = [`Changes for "${diff.name}" (${diff.mode})`]
  for (const view of diff.views) {
    lines.push('', view.label)
    if (view.files.length === 0) {
      lines.push('  (no changes)')
      continue
    }
    for (const file of view.files) {
      lines.push(`  ${file.status.toUpperCase().padEnd(8)} ${file.path}`)
      if (file.patch.length > 0) {
        lines.push(file.patch.replace(/\n$/, ''))
      }
    }
  }
  return lines.join('\n')
}

/** `skillbox merge` summary (M20): files / changes / baseRevision update. */
export function renderMergeOutcome(outcome: MergeOutcome): string {
  switch (outcome.kind) {
    case 'merged':
      return mergeDoneSummary('Merged', outcome.name, {
        filesMerged: outcome.filesMerged,
        changes: outcome.changes,
        baseRevision: outcome.baseRevision,
      })
    case 'continued':
      return mergeDoneSummary('Merge of', `${outcome.name} completed`, {
        filesMerged: outcome.filesMerged,
        changes: outcome.changes,
        baseRevision: outcome.baseRevision,
      })
    case 'aborted':
      return `Merge aborted for "${outcome.name}" — restored ${outcome.filesRestored} file(s).`
  }
}

function mergeDoneSummary(
  verb: string,
  target: string,
  info: { filesMerged: number; changes: number; baseRevision: string | undefined },
): string {
  const lines = [
    `${verb} "${target}"`,
    `  files         ${info.filesMerged}`,
    `  changes       ${info.changes}`,
  ]
  if (info.baseRevision !== undefined && info.baseRevision !== '') {
    lines.push(`  base revision ${info.baseRevision} (updated)`)
  }
  return lines.join('\n')
}
