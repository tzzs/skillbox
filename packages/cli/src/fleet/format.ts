import type { FleetHostConfig, FleetHostResult, FleetRunResult } from '@skillbox/core'
import { renderTable } from '../table.js'

export function renderFleetHostsTable(hosts: readonly FleetHostConfig[]): string {
  if (hosts.length === 0) {
    return '(no fleet hosts configured — add .skillbox/fleet.yaml, or use --ssh for ad-hoc hosts)'
  }
  return renderTable(
    ['NAME', 'HOST', 'USER', 'PORT', 'TAGS'],
    hosts.map((host) => [
      host.name,
      host.host,
      host.user ?? '-',
      host.port === undefined ? '-' : String(host.port),
      host.tags !== undefined && host.tags.length > 0 ? host.tags.join(',') : '-',
    ]),
  )
}

/** First non-blank line of whichever stream best explains the outcome. */
function detailLine(result: FleetHostResult): string {
  if (result.error !== undefined) {
    return result.error
  }
  const text = result.ok ? result.stdout : result.stderr || result.stdout
  const line = text.split('\n').find((entry) => entry.trim() !== '')
  return line ?? ''
}

export function renderFleetRunTable(result: FleetRunResult): string {
  const rows = result.results.map((entry) => [
    entry.host,
    entry.ok ? 'ok' : 'FAIL',
    entry.exitCode === null ? '-' : String(entry.exitCode),
    `${entry.durationMs}ms`,
    detailLine(entry),
  ])
  const table = renderTable(['HOST', 'STATUS', 'EXIT', 'DURATION', 'DETAIL'], rows)
  const failed = result.results.filter((entry) => !entry.ok).length
  const summary =
    failed === 0
      ? `All ${result.results.length} host(s) succeeded.`
      : `${failed} of ${result.results.length} host(s) failed.`
  return `${table}\n\n${summary}`
}
