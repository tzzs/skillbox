import * as path from 'node:path'
import { AgentRegistry } from '../agent/index.js'
import { emptyManifest, readManifest, writeManifest } from '../manifest/index.js'
import { isSkillboxError } from '../errors.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { SkillService } from './skill-service.js'

/** Fixed location of the machine-centric personal library: `<home>/personal`. */
export function personalLibraryRoot(homeRoot: string): string {
  return path.join(homeRoot, 'personal')
}

export interface PersonalLibraryServiceOptions {
  /** Skillbox home root; the personal repository lives at `<homeRoot>/personal`. */
  homeRoot: string
  registry?: AgentRegistry
  filesystem?: FilesystemService
}

export interface AdoptSkip {
  name: string
  agents: string[]
  reason: string
}

export interface AdoptReport {
  /** Agent skills detected across every detected adapter (deduped by name). */
  scanned: number
  imported: number
  unchanged: number
  conflicts: number
  skipped: AdoptSkip[]
}

/**
 * Machine-centric personal library (V0.5): a fixed skillbox repository at
 * `<home>/personal` that exists so "open the tool → see all my skills" works
 * without the user picking a repository first. `adopt()` scans every detected
 * agent's external skills and imports them into the personal repository with
 * agent migration — idempotently (already-imported skills report `unchanged`)
 * and with per-item error isolation (one broken directory never aborts the
 * batch).
 *
 * The repository-centric model is unchanged: explicit repositories (cwd with a
 * manifest or `--repository`) are never auto-adopted; only the personal
 * library adopts.
 */
export class PersonalLibraryService {
  private readonly homeRoot: string
  private readonly registry: AgentRegistry | undefined
  private readonly filesystem: FilesystemService

  constructor(options: PersonalLibraryServiceOptions) {
    this.homeRoot = options.homeRoot
    this.registry = options.registry
    this.filesystem = options.filesystem ?? new FilesystemService()
  }

  /** Absolute root of the personal repository. */
  root(): string {
    return personalLibraryRoot(this.homeRoot)
  }

  /**
   * Creates the personal repository if it does not exist yet (an empty
   * manifest is enough — local skills need no git) and returns its root.
   */
  async ensureLibrary(): Promise<string> {
    const root = this.root()
    await this.filesystem.mkdir(root)
    const manifestPath = path.join(root, 'skillbox.yaml')
    if (!(await this.filesystem.exists(manifestPath))) {
      await writeManifest(root, emptyManifest())
    }
    return root
  }

  /** True when the personal repository exists but declares no skills. */
  async isEmpty(): Promise<boolean> {
    const root = this.root()
    if (!(await this.filesystem.exists(path.join(root, 'skillbox.yaml')))) {
      return true
    }
    const manifest = await readManifest(root)
    return Object.keys(manifest.skills).length === 0
  }

  /**
   * Scans every detected agent for unmanaged external skills and imports them
   * into the personal repository. Safe to run repeatedly: already-imported
   * skills with identical content resolve to `unchanged`, and same-name
   * different-content collisions are reported as skipped conflicts instead of
   * overwriting anything.
   */
  async adopt(): Promise<AdoptReport> {
    const root = await this.ensureLibrary()
    const skills = new SkillService({
      repositoryRoot: root,
      homeRoot: this.homeRoot,
      ...(this.registry === undefined ? {} : { registry: this.registry }),
      filesystem: this.filesystem,
    })

    const report: AdoptReport = { scanned: 0, imported: 0, unchanged: 0, conflicts: 0, skipped: [] }
    for (const candidate of await this.scanExternalSkills()) {
      report.scanned += 1
      try {
        const result = await skills.importExistingSkill({
          name: candidate.name,
          sourceDir: candidate.sourceDir,
          ...(candidate.agents.length > 0 ? { migrateAgents: candidate.agents } : {}),
        })
        if (result.status === 'imported') {
          report.imported += 1
        } else if (result.status === 'unchanged') {
          report.unchanged += 1
        } else if (result.status === 'conflict') {
          report.conflicts += 1
          report.skipped.push({
            name: candidate.name,
            agents: candidate.agents,
            reason: 'existing skill with different content',
          })
        } else {
          report.skipped.push({
            name: candidate.name,
            agents: candidate.agents,
            reason: result.status,
          })
        }
      } catch (error) {
        report.skipped.push({
          name: candidate.name,
          agents: candidate.agents,
          reason: isSkillboxError(error) ? error.code : 'import failed',
        })
      }
    }
    return report
  }

  /**
   * Detects agents and collects unmanaged external skills, deduped by name.
   * Directories without a SKILL.md (agent-internal dirs like `.system`) are
   * filtered out here so a broken candidate never aborts the batch.
   */
  private async scanExternalSkills(): Promise<
    Array<{ name: string; sourceDir: string; agents: string[] }>
  > {
    if (this.registry === undefined) {
      return []
    }
    const byName = new Map<string, { name: string; sourceDir: string; agents: string[] }>()
    for (const adapter of this.registry.list()) {
      let detected = false
      try {
        detected = (await adapter.detect()).detected
      } catch {
        detected = false
      }
      if (!detected) {
        continue
      }
      let installed: Awaited<ReturnType<typeof adapter.scanSkills>> = []
      try {
        installed = await adapter.scanSkills()
      } catch {
        installed = []
      }
      for (const skill of installed) {
        if (skill.managedBySkillbox) {
          continue
        }
        if (!(await this.filesystem.exists(path.join(skill.path, 'SKILL.md')))) {
          continue
        }
        const existing = byName.get(skill.name)
        if (existing === undefined) {
          byName.set(skill.name, { name: skill.name, sourceDir: skill.path, agents: [adapter.id] })
        } else if (!existing.agents.includes(adapter.id)) {
          existing.agents.push(adapter.id)
        }
      }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
  }
}
