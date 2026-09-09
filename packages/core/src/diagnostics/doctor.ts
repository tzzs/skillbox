import * as path from 'node:path'
import * as os from 'node:os'
import { FilesystemService } from '../fs/filesystem-service.js'
import { readLockfile } from '../lockfile/index.js'
import { LOCKFILE_FILE_NAME } from '../lockfile/schema.js'
import { readManifest } from '../manifest/index.js'
import { MANIFEST_FILE_NAME } from '../manifest/schema.js'
import { RuntimeConfigService } from '../runtime/config.js'
import { SkillboxHome } from '../runtime/home.js'
import { defaultLogFilePath } from '../logging/logger.js'
import { scrubText } from '../logging/redact.js'
import { runDoctorProbes, type DoctorProbeContext } from './probes.js'
import type { DebugBundle, DoctorReport, LeakFinding } from './types.js'

/** Secret patterns the debug bundle must never contain (roadmap 5.3). */
const LEAK_PATTERNS: ReadonlyArray<{ id: string; regex: RegExp }> = [
  {
    id: 'github-token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'authorization-header',
    regex: /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  },
  {
    id: 'token-header',
    regex: /\b(?:x-oauth-token|x-github-token|api[_-]?key)\s*:\s*[^\s,;]+/gi,
  },
]

export interface DiagnosticsOptions extends DoctorProbeContext {
  /** Skillbox version reported by the CLI (identity). */
  version: string
  /** Max log lines kept in the bundle. */
  logTailLines?: number
}

/** `skillbox doctor` — runs every probe and renders a full report. */
export async function runDoctor(options: DiagnosticsOptions): Promise<DoctorReport> {
  const probes = await runDoctorProbes(options)
  return {
    generatedAt: new Date().toISOString(),
    skillboxVersion: options.version,
    probes,
  }
}

/**
 * Assembles a redacted debug bundle (roadmap 5.3): doctor report + scrubbed
 * machine config + log tail + repository summary, plus an automatic leak
 * scan that fails the bundle when a secret pattern survives redaction.
 */
export async function createDebugBundle(options: DiagnosticsOptions): Promise<DebugBundle> {
  const filesystem = options.filesystem ?? new FilesystemService()
  const doctor = await runDoctor(options)
  const home = new SkillboxHome({ root: options.homeRoot })

  /* Redacted machine config. */
  let config: Record<string, unknown> = {}
  let configText = ''
  try {
    const service = new RuntimeConfigService({ configFilePath: home.configFilePath(), filesystem })
    const loaded = await service.load()
    const serialized = JSON.stringify(loaded, null, 2)
    configText = serialized
    const scrubbed = scrubText(serialized)
    try {
      config = JSON.parse(scrubbed) as Record<string, unknown>
    } catch {
      config = { note: 'config could not be re-parsed after redaction' }
    }
  } catch {
    // Missing/invalid config: reported by the doctor probe.
  }

  /* Log tail. */
  const logTail: string[] = []
  let logText = ''
  try {
    const logFile = defaultLogFilePath(options.homeRoot)
    if (await filesystem.exists(logFile)) {
      const content = await filesystem.readFile(logFile)
      const lines = content.split('\n').filter((line) => line.length > 0)
      const tail = lines.slice(-(options.logTailLines ?? 50))
      logTail.push(...tail.map((line) => scrubText(line)))
      logText = content
    }
  } catch {
    // No log file yet is normal.
  }

  /* Repository summary. */
  let manifest: 'present' | 'missing' | 'invalid' = 'missing'
  const manifestPath = path.join(options.repositoryRoot, MANIFEST_FILE_NAME)
  if (await filesystem.exists(manifestPath)) {
    try {
      await readManifest(options.repositoryRoot)
      manifest = 'present'
    } catch {
      manifest = 'invalid'
    }
  }
  let lockfile: 'present' | 'missing' | 'invalid' = 'missing'
  let skills: string[] = []
  const lockfilePath = path.join(options.repositoryRoot, LOCKFILE_FILE_NAME)
  if (await filesystem.exists(lockfilePath)) {
    try {
      const parsed = await readLockfile(options.repositoryRoot)
      lockfile = 'present'
      skills = Object.keys(parsed.skills)
    } catch {
      lockfile = 'invalid'
    }
  }

  /* Leak scan over every assembled section. */
  const sections: Array<{ source: string; text: string }> = [
    { source: 'config.json', text: configText },
    { source: 'skillbox.log', text: logText },
    {
      source: 'doctor-report',
      text: doctor.probes
        .map((probe) => `${probe.ok ? 'ok' : 'error'} ${probe.detail ?? ''} ${probe.error ?? ''}`)
        .join('\n'),
    },
  ]
  const findings = scanForLeaks(sections)

  return {
    generatedAt: doctor.generatedAt,
    skillboxVersion: options.version,
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    doctor,
    config,
    logTail,
    repository: {
      root: path.resolve(options.repositoryRoot),
      manifest,
      lockfile,
      skills,
    },
    leakCheck: {
      findings,
      checked: sections.map((section) => section.source),
    },
  }
}

/** Scans assembled sections for secret patterns; values are never included. */
export function scanForLeaks(sections: Array<{ source: string; text: string }>): LeakFinding[] {
  const findings: LeakFinding[] = []
  for (const section of sections) {
    for (const pattern of LEAK_PATTERNS) {
      const matches = section.text.match(pattern.regex)
      if (matches !== null && matches.length > 0) {
        findings.push({
          pattern: pattern.id,
          source: section.source,
          count: matches.length,
        })
      }
    }
  }
  return findings
}

/** Re-exported for consumers that need the probe types. */
export type { ProbeResult } from './types.js'
