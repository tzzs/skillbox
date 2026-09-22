import * as path from 'node:path'
import { AgentRegistry, type AgentDetectionSummary } from '../agent/index.js'
import type { SkillMode, SkillStatus } from '../domain/index.js'
import {
  deriveMode,
  emptyManifest,
  readManifest,
  type ManifestSkillSource,
  type SkillboxManifest,
} from '../manifest/index.js'
import { emptyLockfile, readLockfile, type SkillboxLockfile } from '../lockfile/index.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import type { NormalizedSource } from '../registry/types.js'
import { planRemoteSource } from '../git/index.js'
import { resolveSkillboxHome } from '../runtime/paths.js'
import { RUNTIME_MODE_DIRECTORIES } from '../runtime/library.js'
import { hasPendingMerge } from '../merge/state.js'

/**
 * Minimal upstream lookup used for outdated detection (M16.1). The registry
 * framework's `RegistryProvider` is structurally compatible with this
 * interface, so a full provider can be passed in once agent 1's framework
 * lands.
 */
export interface UpstreamRevisionProvider {
  /** Latest upstream revision for a source (e.g. default-branch commit SHA). */
  getLatestRevision(source: NormalizedSource): Promise<string>
}

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
  /**
   * Skillbox home root; the managed runtime lives under `<homeRoot>/library`.
   * Defaults to the resolved Skillbox home (env-overridable).
   */
  homeRoot?: string
  /**
   * Upstream lookup for outdated detection (M16.1). When omitted (or when
   * the lookup fails), the lockfile's recorded `upstream.latestRevision` is
   * used as a fallback; without either, managed skills never report
   * `outdated`.
   */
  provider?: UpstreamRevisionProvider
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
  private readonly provider: UpstreamRevisionProvider | undefined
  private readonly homeRoot: string
  /** In-flight full-status computation, shared across concurrent callers. */
  private statusInFlight: Promise<RepositoryStatus> | undefined

  constructor(options: StatusServiceOptions) {
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.repositoryRoot = options.repositoryRoot
    this.registry = options.registry
    this.provider = options.provider
    this.homeRoot = options.homeRoot ?? resolveSkillboxHome()
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

    // M20.5 — a pending merge takes precedence over every other state: the
    // skill's content holds unresolved conflict markers and the merge command
    // must be continued or aborted before anything else.
    if (await hasPendingMerge(resolveSkillboxHome(), alias, this.filesystem)) {
      entry.status = 'conflict'
      entry.message =
        'merge in progress — resolve conflicts and run "skillbox merge --continue" or "skillbox merge --abort"'
      return entry
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
   * Read-only status of a remote (git/github) source. The live runtime of a
   * managed skill is its materialized library copy — the same directory agent
   * links point at — so integrity is compared there against the lockfile. The
   * install cache layouts differ between the marketplace and reconcile
   * pipelines, so neither cache root is a reliable comparison target.
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

    if (planRemoteSource(skill.source) === undefined) {
      entry.message = `${skill.source.type} sources require a registry provider (V0.3)`
      return entry
    }

    const subPath =
      skill.source.type === 'git' || skill.source.type === 'github' ? skill.source.path : undefined
    if (subPath !== undefined && subPath.split(/[\\/]/).includes('..')) {
      entry.status = 'broken'
      entry.message = `unresolvable source path "${subPath}"`
      return entry
    }

    const runtimeDir = path.join(
      this.homeRoot,
      'library',
      RUNTIME_MODE_DIRECTORIES.managed,
      alias,
    )
    if (!(await this.isDirectory(runtimeDir))) {
      entry.message = 'remote skill not materialized (run "skillbox install")'
      return entry
    }
    if (!(await this.filesystem.exists(path.join(runtimeDir, 'SKILL.md')))) {
      entry.status = 'broken'
      entry.message = 'missing SKILL.md'
      return entry
    }

    entry.path = runtimeDir
    const integrity = await computeSkillIntegrity(runtimeDir)
    const lockedIntegrity = lock.skills[alias]?.integrity
    entry.integrity = integrity
    if (lockedIntegrity !== undefined) {
      entry.lockIntegrity = lockedIntegrity
    }
    entry.status =
      lockedIntegrity === undefined || lockedIntegrity === integrity ? 'ready' : 'modified'
    if (entry.status === 'ready') {
      entry.status = await this.outdatedStatus(alias, skill, lock, entry)
    }
    return entry
  }

  /**
   * M16.1 outdated detection for managed skills: compares the locked revision
   * against the latest upstream revision. A `modified` (integrity mismatch)
   * state takes precedence — an outdated check is only reached on `ready`.
   *
   * TODO(agent-1): wiring point — this calls the registry framework's
   * `getLatestRevision` through the injected `UpstreamRevisionProvider`
   * (structurally compatible with `RegistryProvider`). The framework is
   * being built in parallel (`packages/core/src/registry/`); tests inject a
   * mock provider, and without one the lockfile's recorded
   * `upstream.latestRevision` is used as a fallback.
   */
  private async outdatedStatus(
    alias: string,
    _skill: SkillboxManifest['skills'][string],
    lock: SkillboxLockfile,
    entry: SkillStatusEntry,
  ): Promise<SkillStatus> {
    const locked = lock.skills[alias]
    if (locked?.revision === undefined) {
      return 'ready'
    }
    const latest = await this.latestUpstreamRevision(locked)
    if (latest === undefined || latest === locked.revision) {
      return 'ready'
    }
    entry.message = `newer upstream revision ${latest} available (installed ${locked.revision})`
    return 'outdated'
  }

  /**
   * Latest upstream revision for a locked skill, preferring the live provider
   * and falling back to the lockfile's recorded `upstream.latestRevision`.
   * Returns `undefined` when neither is available or the lookup fails
   * (a registry outage must not fail the whole status report).
   */
  private async latestUpstreamRevision(
    locked: SkillboxLockfile['skills'][string],
  ): Promise<string | undefined> {
    if (this.provider !== undefined) {
      const normalized = manifestSourceToNormalized(locked.source)
      if (normalized !== undefined) {
        try {
          return await this.provider.getLatestRevision(normalized)
        } catch {
          // registry unavailable — fall through to the recorded value
        }
      }
    }
    return locked.upstream?.latestRevision
  }

  private async isDirectory(target: string): Promise<boolean> {
    try {
      return (await this.filesystem.stat(target)).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Read-only status of a single manifest skill, without computing the rest of
   * the repository. Returns `undefined` when the alias is not declared. Used by
   * the Web detail route so fetching one skill costs one integrity hash, not the
   * full library.
   */
  async skillStatus(name: string): Promise<SkillStatusEntry | undefined> {
    const { manifest } = await this.readManifestOrEmpty()
    const skill = manifest.skills[name]
    if (skill === undefined) {
      return undefined
    }
    const { lockfile } = await this.lockfileOrEmpty()
    return this.describeSkill(name, skill, lockfile)
  }

  /**
   * Full read-only status report (M8.9 / M8.10). Concurrent callers share a
   * single in-flight computation (single-flight) so a burst of requests — the
   * Library list plus the status poll — recomputes the whole library once, not
   * once per request.
   */
  async status(): Promise<RepositoryStatus> {
    if (this.statusInFlight !== undefined) {
      return this.statusInFlight
    }
    const inFlight = this.computeStatus().finally(() => {
      if (this.statusInFlight === inFlight) {
        this.statusInFlight = undefined
      }
    })
    this.statusInFlight = inFlight
    return inFlight
  }

  private async computeStatus(): Promise<RepositoryStatus> {
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

/**
 * Maps a locked (manifest-shaped) source onto the registry framework's
 * `NormalizedSource` for upstream lookups. Git sources have no normalized
 * form yet — they return `undefined`, so outdated detection is skipped for
 * them (the lockfile fallback still applies).
 */
function manifestSourceToNormalized(source: ManifestSkillSource): NormalizedSource | undefined {
  switch (source.type) {
    case 'github': {
      const normalized: NormalizedSource = { type: 'github', repo: source.repo }
      if (source.path !== undefined) normalized.path = source.path
      if (source.ref !== undefined) normalized.ref = source.ref
      return normalized
    }
    case 'registry': {
      if (source.registry !== 'skills.sh') {
        return undefined
      }
      const normalized: NormalizedSource = { type: 'skills-sh', package: source.package }
      if (source.version !== undefined) normalized.version = source.version
      return normalized
    }
    default:
      return undefined
  }
}
