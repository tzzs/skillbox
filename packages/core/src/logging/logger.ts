import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { FilesystemService } from '../fs/filesystem-service.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import type { Severity, Verbosity } from './levels.js'
import { getGlobalVerbosity, shouldLog } from './levels.js'
import { REDACTED, safeSerialize, scrubText } from './redact.js'

export interface LoggerOptions {
  /** Minimum verbosity; defaults to `normal`. */
  verbosity?: Verbosity
  /** Console sink for human-facing output (defaults to `process.stderr`). */
  emit?: (chunk: string) => void
  /** Optional file the serialized log lines are appended to. */
  logFile?: string
  /** Filesystem wrapper used to ensure the log directory exists. */
  filesystem?: FilesystemService
  /** Time source (injected for deterministic tests). */
  now?: () => Date
}

/** Default log location: `~/.skillbox/logs/skillbox.log` for a home root. */
export function defaultLogFilePath(homeRoot: string): string {
  return path.join(buildSkillboxHomeLayout(homeRoot).logs, 'skillbox.log')
}

/** Formats a single log line with an ISO timestamp, severity and optional context. */
export function formatLogLine(
  timestamp: Date,
  severity: Severity,
  message: string,
  context?: unknown,
): string {
  const label = severity.toUpperCase().padEnd(5)
  if (context === undefined) {
    return `[${timestamp.toISOString()}] ${label} ${scrubText(message)}`
  }
  return `[${timestamp.toISOString()}] ${label} ${scrubText(message)} ${safeSerialize(context)}`
}

/**
 * Lightweight logger (MVP_TASKS §184). Verbosity  controls which severities are
 * emitted; secrets are masked before anything leaves the process (SPEC §76).
 *
 * At `normal` verbosity the logger stays silent on the console so everyday CLI
 * runs are not polluted; `verbose`/`debug` runs stream detail to stderr and,
 * when a log file is configured, every emitted line is appended to it.
 */
export class Logger {
  private verbosity: Verbosity
  private readonly logFile: string | undefined
  private filesystem: FilesystemService
  private now: () => Date
  private emitLine: (chunk: string) => void
  private tail: Promise<void> = Promise.resolve()
  private dirEnsured = false

  constructor(options: LoggerOptions = {}) {
    this.verbosity = options.verbosity ?? getGlobalVerbosity()
    this.emitLine = options.emit ?? ((chunk: string) => process.stderr.write(chunk))
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.now = options.now ?? (() => new Date())
    if (options.logFile !== undefined) {
      this.logFile = options.logFile
    }
  }

  get verbosityLevel(): Verbosity {
    return this.verbosity
  }

  /** Reconfigures the logger with the given overrides. */
  configure(options: LoggerOptions): void {
    if (options.verbosity !== undefined) {
      this.verbosity = options.verbosity
    }
    if (options.emit !== undefined) {
      this.emitLine = options.emit
    }
    if (options.filesystem !== undefined) {
      this.filesystem = options.filesystem
    }
    if (options.now !== undefined) {
      this.now = options.now
    }
  }

  /** Whether messages of `severity` would currently be emitted. */
  enabled(severity: Severity): boolean {
    return shouldLog(this.verbosity, severity)
  }

  error(message: string, context?: unknown): void {
    this.write('error', message, context)
  }

  warn(message: string, context?: unknown): void {
    this.write('warn', message, context)
  }

  info(message: string, context?: unknown): void {
    this.write('info', message, context)
  }

  verbose(message: string, context?: unknown): void {
    this.write('verbose', message, context)
  }

  debug(message: string, context?: unknown): void {
    this.write('debug', message, context)
  }

  private write(severity: Severity, message: string, context?: unknown): void {
    if (!shouldLog(this.verbosity, severity)) {
      return
    }
    const line = formatLogLine(this.now(), severity, message, context)
    if (this.verbosity === 'verbose' || this.verbosity === 'debug') {
      this.emitLine(`${line}\n`)
    }
    if (this.logFile !== undefined) {
      this.append(line)
    }
  }

  /** Awaits completion of every pending file write. */
  async flush(): Promise<void> {
    await this.tail
  }

  private append(line: string): void {
    if (this.logFile === undefined) {
      return
    }
    const file = this.logFile
    this.tail = this.tail
      .then(async () => {
        if (!this.dirEnsured) {
          await this.filesystem.mkdir(path.dirname(file))
          this.dirEnsured = true
        }
        await fs.appendFile(file, `${line}\n`, 'utf8')
      })
      .catch(() => {
        // Logging must never crash the code path that produced the message.
      })
  }

  // Re-exports so consumers can reference the redacted marker without an extra import.
  readonly REDACTED: string = REDACTED
}
