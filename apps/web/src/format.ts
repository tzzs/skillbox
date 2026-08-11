const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  modified: 'Modified',
  outdated: 'Outdated',
  conflict: 'Conflict',
  missing: 'Missing',
  broken: 'Broken',
}

const MODE_LABELS: Record<string, string> = {
  local: 'Local',
  managed: 'Managed',
  forked: 'Forked',
  vendored: 'Vendored',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode
}

/** CSS class for the status badge (status colors live in styles.css). */
export function statusClass(status: string): string {
  const safe = status.toLowerCase().replace(/[^a-z]/g, '')
  return `status-${safe}`
}

export function absoluteToRelative(value: string | undefined, repositoryRoot?: string): string {
  if (value === undefined) {
    return '—'
  }
  if (repositoryRoot !== undefined && value.startsWith(repositoryRoot)) {
    return value.slice(repositoryRoot.length) || './'
  }
  return value
}

/** Human-readable message for any error thrown by the API client. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
