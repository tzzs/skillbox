import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { collectDiagnostics } from '../diagnostics/diagnostics.js'
import type { DiagnosticReport } from '../diagnostics/types.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'

const SECRET_KEY = /(token|secret|password|authorization|api[-_]?key|credential)/i
const REDACTED = '[REDACTED]'

export interface DebugBundleOptions {
  repositoryRoot: string
  homeRoot: string
  /** A caller-selected location. Defaults to `<home>/logs/debug-bundle.json`. */
  outputFile?: string
  /** Optional caller metadata. Every value is recursively redacted before writing. */
  details?: Record<string, unknown>
  /** Test/platform seam; production callers use Core diagnostics. */
  collectDiagnostics?: (input: { repositoryRoot: string }) => Promise<DiagnosticReport>
}

export interface DebugBundleResult {
  outputFile: string
  generatedAt: string
}

interface DebugBundleDocument {
  schemaVersion: 1
  generatedAt: string
  repositoryRoot: string
  diagnostics: DiagnosticReport
  runtimeConfig: unknown
  details: Record<string, unknown>
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return value
  }
}

/** Recursively removes credentials from values that may be written to support artifacts. */
export function redactDebugValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) return REDACTED
  if (typeof value === 'string') return redactUrl(value)
  if (Array.isArray(value)) return value.map((item) => redactDebugValue(item))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactDebugValue(entryValue, entryKey),
      ]),
    )
  }
  return value
}

async function loadRuntimeConfig(homeRoot: string): Promise<unknown> {
  const configFile = buildSkillboxHomeLayout(homeRoot).configFile
  try {
    return JSON.parse(await fs.readFile(configFile, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return { unreadable: true }
  }
}

/**
 * Writes a deliberately small JSON support artifact. It never reads credential
 * stores, repository content, operation snapshots, or arbitrary log files.
 */
export async function createDebugBundle(options: DebugBundleOptions): Promise<DebugBundleResult> {
  const generatedAt = new Date().toISOString()
  const outputFile = path.resolve(
    options.outputFile ??
      path.join(buildSkillboxHomeLayout(options.homeRoot).logs, 'debug-bundle.json'),
  )
  const diagnostics = await (options.collectDiagnostics ?? collectDiagnostics)({
    repositoryRoot: options.repositoryRoot,
  })
  const document: DebugBundleDocument = {
    schemaVersion: 1,
    generatedAt,
    repositoryRoot: path.resolve(options.repositoryRoot),
    diagnostics: redactDebugValue(diagnostics) as DiagnosticReport,
    runtimeConfig: redactDebugValue(await loadRuntimeConfig(options.homeRoot)),
    details: redactDebugValue(options.details ?? {}) as Record<string, unknown>,
  }
  await atomicWriteFile(outputFile, `${JSON.stringify(document, null, 2)}\n`)
  return { outputFile, generatedAt }
}
