import type { DiagnosticCheck, DiagnosticReport } from '@skillbox/core'

function detail(check: DiagnosticCheck): string {
  switch (check.id) {
    case 'node':
      return `Node ${check.version} (requires >=${check.minimumMajor})`
    case 'git':
      if (check.installed)
        return check.version === undefined ? 'Git available' : `Git ${check.version}`
      return check.detail ?? 'Git is not available on PATH'
    case 'manifest':
    case 'lockfile':
      return check.present ? check.path : `Missing: ${check.path}`
  }
}

/** Human-readable, stable summary for the `skillbox doctor` public command. */
export function renderDiagnostics(report: DiagnosticReport): string {
  const lines = [
    `Skillbox doctor: ${report.ready ? 'ready' : 'not ready'}`,
    `Repository: ${report.repositoryRoot}`,
  ]
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase().padEnd(5)} ${check.id.padEnd(8)} ${detail(check)}`)
  }
  return lines.join('\n')
}
