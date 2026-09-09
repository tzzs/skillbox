/** Diagnostics domain types (roadmap 5.3): `skillbox doctor` + debug bundle. */

export interface ProbeResult {
  name: string
  ok: boolean
  /** Human detail (version, counts) — shown when ok. */
  detail?: string
  /** Failure message (already secret-scrubbed). */
  error?: string
}

export interface DoctorReport {
  generatedAt: string
  skillboxVersion: string
  probes: ProbeResult[]
}

/** A secret leak found while assembling a debug bundle. */
export interface LeakFinding {
  /** Pattern id, e.g. `github-token`. */
  pattern: string
  /** Where the leak was found, e.g. `config.json`. */
  source: string
  /** Number of matches (values are never included). */
  count: number
}

export interface DebugBundle {
  generatedAt: string
  skillboxVersion: string
  nodeVersion: string
  platform: string
  doctor: DoctorReport
  /** Machine config, serialized through the redactor (no secret values). */
  config: Record<string, unknown>
  /** Tail of `~/.skillbox/logs/skillbox.log` (scrubbed lines). */
  logTail: string[]
  repository: {
    root: string
    manifest: 'present' | 'missing' | 'invalid'
    lockfile: 'present' | 'missing' | 'invalid'
    /** Locked skill aliases when the lockfile parses. */
    skills: string[]
  }
  /** Result of the automatic leak scan over the assembled text. */
  leakCheck: {
    findings: LeakFinding[]
    /** File names / sections scanned. */
    checked: string[]
  }
}
