import type { DiagnosticReport } from '@skillbox/core'

/** Input accepted by the CLI-to-Core diagnostics boundary. */
export interface DiagnosticsInput {
  repositoryRoot: string
}

/** Injectable public seam behind `skillbox doctor`. */
export interface DiagnosticsProvider {
  collect(input: DiagnosticsInput): Promise<DiagnosticReport>
}
