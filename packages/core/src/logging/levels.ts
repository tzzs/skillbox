/**
 * Logging levels (MVP_TASKS §184).
 *
 * Verbosity is the process-wide log level driven by the CLI `--verbose` /
 * `--debug` flags. Each logged message carries a Severity; whether a message
 * is emitted depends on the configured Verbosity.
 *
 * - normal:  the default — errors, warnings and important informational lines
 * - verbose: additionally emits detailed step-by-step output
 * - debug:   everything, including function-level traces
 */
export const Verbosity = {
  normal: 'normal',
  verbose: 'verbose',
  debug: 'debug',
} as const

export type Verbosity = (typeof Verbosity)[keyof typeof Verbosity]

export const LOG_VERBOSITIES: readonly Verbosity[] = ['normal', 'verbose', 'debug']

/** Severity of an individual log message. */
export const Severity = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  verbose: 'verbose',
  debug: 'debug',
} as const

export type Severity = (typeof Severity)[keyof typeof Severity]

/** Rank of a severity: higher values require a more verbose log. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
}

/** Highest severity emitted at each verbosity (inclusive). */
export const VERBOSITY_MAX_SEVERITY: Record<Verbosity, Severity> = {
  normal: 'info',
  verbose: 'verbose',
  debug: 'debug',
}

/** Whether a message of `severity` is emitted at the given `verbosity`. */
export function shouldLog(verbosity: Verbosity, severity: Severity): boolean {
  return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[VERBOSITY_MAX_SEVERITY[verbosity]]
}

/**
 * Process-wide default verbosity, driven by the CLI `--verbose` / `--debug`
 * flags. `Logger` instances created without an explicit verbosity pick this up,
 * so every log site follows the CLI banner without per-site configuration.
 */
let globalVerbosity: Verbosity = Verbosity.normal

export function setGlobalVerbosity(verbosity: Verbosity): void {
  globalVerbosity = verbosity
}

export function getGlobalVerbosity(): Verbosity {
  return globalVerbosity
}
