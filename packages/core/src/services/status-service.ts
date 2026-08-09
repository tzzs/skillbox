import * as path from 'node:path'
import { AgentRegistry, type AgentDetectionSummary } from '../agent/index.js'
import type { SkillMode, SkillStatus } from '../domain/index.js'
import {
  deriveMode,
  emptyManifest,
  readManifest,
  type SkillboxManifest,
} from '../manifest/index.js'
import { emptyLockfile, readLockfile, type SkillboxLockfile } from '../lockfile/index.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import { planRemoteSource, remoteMaterializeRoot } from '../git/index.js'
import { resolveSkillboxHome } from '../runtime/paths.js'

/** A skill in the read-only status output, with its computed current status. */
export interface SkillStatusEntry {
  name: string
  mode: SkillMode
  status: SkillStatus
  /** Absolute source path of the skill directory (local skills only). */
  path?: string
  /** Currently computed integrity of the on-disk skill. */
  integrity?: string
  /** Integrity recorded in the lockfile. */
  lockIntegrity?: string
  /** Agents this skill is enabled for. */
  agents: string[]
  /** Human-readable reason when the status is not `ready`. */
  message?: string
}

export interface RepositoryStatus {
  repositoryRoot: string
  manifestPath: string
  manifestPresent: boolean
  lockfilePath: string
  lockfilePresent: boolean
  skills: SkillStatusEntry[]
  modified: string[]
  broken: string[]
  agents: AgentDetectionSummary[]
}

export interface StatusServiceOptions {
  repositoryRoot: string
  /** Registry for agent detection; `status()` reports agents from it. */
  registry?: AgentRegistry
  filesystem?: FilesystemService
  /** Local root where remote git clones are cached (defaults to the home cache). */
  remoteRoot?: string
}

/**
 * M8.9 read-only aggregation: reads the Manifest + Lockfile and derives the
 * current status of every skill, the Agents and the repository health. Never
 * writes to disk.
 */
export class StatusService {
  private readonly filesystem: FilesystemService
  private readonly repositoryRoot: string
  private readonly registry: AgentRegistry | undefined
  private readonly remoteRoot: string

  constructor(options: StatusServiceOptions) {
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.repositoryRoot = options.repositoryRoot
    this.registry = options.registry
    this.remoteRoot =
      options.remoteRoot ?? remoteMaterializeRoot(path.join(resolveSkillboxHome(), 'library'))
  }

  private async readManifestOrEmpty(): Promise<{
    manifest: SkillboxManifest
    path: string
    present: boolean
  }> {
    const filePath = path.join(this.repositoryRoot, 'skillbox.yaml')
    try {
      const manifest = await readManifest(this.repositoryRoot)
      return { manifest, path: filePath, present: true }
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.MANIFEST_NOT_FOUND) {
        return { manifest: emptyManifest(), path: filePath, present: false }
      }
      throw error
    }
  }

  private async lockfileOrEmpty(): Promise<{ lockfile: SkillboxLockfile; present: boolean }> {
    try {
      return { lockfile: await readLockfile(this.repositoryRoot), present: true }
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
        return { lockfile: emptyLockfile(), present: false }
      }
      throw error
    }
  }

  /** Computes the current status of one manifest skill. */
  private async describeSkill(
    alias: string,
    skill: SkillboxManifest['skills'][string],
    lock: SkillboxLockfile,
  ): Promise<SkillStatusEntry> {
    const mode = deriveMode(skill)
    const entry: SkillStatusEntry = {
      name: alias,
      mode,
      status: 'ready',
      agents: skill.agents ?? [],
    }

    if (skill.source.type !== 'local') {
      return this.describeRemoteSkill(alias, skill, lock)
    }

    let sourcePath: string
    try {
      sourcePath = resolveInsideRoot(this.repositoryRoot, skill.source.path)
    } catch {
      entry.status = 'broken'
      entry.message = `unresolvable local path "${skill.source.path}"`
      return entry
    }
    entry.path = sourcePath

    if (!(await this.isDirectory(sourcePath))) {
      entry.status = 'missing'
      entry.message = 'skill directory missing'
      return entry
    }
    if (!(await this.filesystem.exists(path.join(sourcePath, 'SKILL.md')))) {
      entry.status = 'broken'
      entry.message = 'missing SKILL.md'
      return entry
    }

    const integrity = await computeSkillIntegrity(sourcePath)
    const lockedIntegrity = lock.skills[alias]?.integrity
    entry.integrity = integrity
    if (lockedIntegrity !== undefined) {
      entry.lockIntegrity = lockedIntegrity
    }
    entry.status =
      lockedIntegrity === undefined || lockedIntegrity === integrity ? 'ready' : 'modified'
    return entry
  }

  /**
   * Read-only status of a remote (git/github) source. Never runs git here —
   * the expected local mirror is located deterministically and its current
   * state is compared against the lockfile, mirroring the local-skill logic.
   */
  private async describeRemoteSkill(
    alias: string,
    skill: SkillboxManifest['skills'][string],
    lock: SkillboxLockfile,
  ): Promise<SkillStatusEntry> {
    const mode = deriveMode(skill)
    const entry: SkillStatusEntry = {
      name: alias,
      mode,
      status: 'missing',
      agents: skill.agents ?? [],
    }

    const plan = planRemoteSource(skill.source)
    if (plan === undefined) {
      entry.message = `${skill.source.type} sources require a registry provider (V0.3)`
      return entry
    }

    const targetDir = path.join(this.remoteRoot, plan.key)
    let sourcePath = targetDir
    const subPath =
      skill.source.type === 'git' || skill.source.type === 'github' ? skill.source.path : undefined
    if (subPath !== undefined) {
      try {
        sourcePath = resolveInsideRoot(targetDir, subPath)
      } catch {
        entry.status = 'broken'
        entry.message = `unresolvable source path "${subPath}"`
        return entry
      }
    }

    if (!(await this.isDirectory(sourcePath))) {
      entry.status = 'missing'
      entry.message = 'remote skill not materialized (run "skillbox install")'
      return entry
    }
    if (!(await this.filesystem.exists(path.join(sourcePath, 'SKILL.md')))) {
      entry.status = 'broken'
      entry.message = 'missing SKILL.md'
      return entry
    }

    entry.path = sourcePath
    const integrity = await computeSkillIntegrity(sourcePath)
    const lockedIntegrity = lock.skills[alias]?.integrity
    entry.integrity = integrity
    if (lockedIntegrity !== undefined) {
      entry.lockIntegrity = lockedIntegrity
    }
    entry.status =
      lockedIntegrity === undefined || lockedIntegrity === integrity ? 'ready' : 'modified'
    return entry
  }

  private async isDirectory(target: string): Promise<boolean> {
    try {
      return (await this.filesystem.stat(target)).isDirectory()
    } catch {
      return false
    }
  }

  /** Full read-only status report (M8.9 / M8.10). */
  async status(): Promise<RepositoryStatus> {
    const {
      manifest,
      path: manifestPath,
      present: manifestPresent,
    } = await this.readManifestOrEmpty()
    const { lockfile, present: lockfilePresent } = await this.lockfileOrEmpty()

    const skills: SkillStatusEntry[] = []
    for (const [alias, skill] of Object.entries(manifest.skills)) {
      skills.push(await this.describeSkill(alias, skill, lockfile))
    }
    skills.sort((left, right) => left.name.localeCompare(right.name))

    const modified = skills
      .filter((skill) => skill.status === 'modified')
      .map((skill) => skill.name)
    const broken = skills
      .filter((skill) => skill.status === 'missing' || skill.status === 'broken')
      .map((skill) => skill.name)

    return {
      repositoryRoot: this.repositoryRoot,
      manifestPath,
      manifestPresent,
      lockfilePath: path.join(this.repositoryRoot, 'skillbox.lock'),
      lockfilePresent,
      skills,
      modified,
      broken,
      agents: await this.agents(),
    }
  }

  /** Agent detection statuses; a missing registry yields an empty list. */
  async agents(): Promise<AgentDetectionSummary[]> {
    if (this.registry === undefined) {
      return []
    }
    return this.registry.detectAll()
  }
}
