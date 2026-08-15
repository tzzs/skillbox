import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { resolveLinkStrategy, type LinkStrategy, type ResolvedLinkStrategy } from '../fs/links.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import {
  deriveMode,
  readManifest,
  type ManifestSkill,
  type SkillboxManifest,
} from '../manifest/index.js'
import {
  createLockedSkill,
  emptyLockfile,
  readLockfile,
  writeLockfileIfChanged,
  type SkillboxLockfile,
} from '../lockfile/index.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import type { AgentAdapter } from '../agent/adapter.js'
import type { SkillMode } from '../domain/skill.js'
import { RuntimeLibraryService, type MaterializeSkillStatus } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { RuntimeOwnershipResolver } from '../runtime/ownership.js'
import { linkSkillToAgent, removeStaleSkillLink, type LinkAction } from '../runtime/linker.js'
import { fromManifestSource } from '../registry/source.js'
import type { ProviderRegistry } from '../registry/registry.js'
import {
  GitClient,
  planRemoteSource,
  remoteMaterializeRoot,
  type GitMaterializeOptions,
  type GitMaterializeResult,
} from '../git/index.js'

export type ReconcileSkillStatus = 'ok' | 'missing' | 'broken' | 'skipped'

export interface ReconcileSkillLinkReport {
  agent: string
  action: LinkAction
  /** Absolute path of the agent skills-directory entry (when reachable). */
  path?: string
  changed: boolean
}

export interface ReconcileSkillReport {
  alias: string
  mode: SkillMode
  status: ReconcileSkillStatus
  /** Absolute repository path of the local skill source (when resolved). */
  sourcePath?: string
  /** Resolved immutable revision for remote (managed) skills. */
  revision?: string
  integrity?: string
  lockIntegrity?: string
  /** True when the on-disk repository content matches the locked integrity. */
  integrityValid?: boolean
  materialized?: boolean
  materializeStatus?: MaterializeSkillStatus
  materializedPath?: string
  /** Per-agent assignment outcomes for this skill. */
  links?: ReconcileSkillLinkReport[]
  message?: string
}

export interface ReconcileStaleLinkReport {
  agent: string
  alias: string
  action: 'removed' | 'kept_external' | 'not_found'
  /** True when the links state was rewritten on disk. */
  stateChanged: boolean
}

export interface ReconcileAgentReport {
  agent: string
  /** Adapter-provided skill directories (first is used for linking). */
  skillDirectories: string[]
  /** Whether the primary skills directory already exists. */
  dirExists: boolean
}

export interface ReconcileProblem {
  code: string
  alias?: string
  message: string
}

export interface ReconcileResult {
  /** True when this run mutated anything on disk (idempotency: false on repeat). */
  changed: boolean
  repository: string
  linkStrategy: ResolvedLinkStrategy
  skills: ReconcileSkillReport[]
  staleLinks: ReconcileStaleLinkReport[]
  agents: ReconcileAgentReport[]
  problems: ReconcileProblem[]
}

export interface ReconcileOptions {
  repositoryRoot: string
  library: RuntimeLibraryService
  linkState: RuntimeLinkState
  /** Agent adapters available for assignments; keyed by adapter id. */
  adapters?: ReadonlyMap<string, AgentAdapter>
  linkStrategy?: LinkStrategy
  filesystem?: FilesystemService
  /** Git wrapper used to materialize remote sources (defaults to system git). */
  git?: GitClient
  /** Local root where remote clones are cached (defaults to the home cache). */
  remoteRoot?: string
  /**
   * Registry provider framework used to materialize sources the git engine
   * cannot clone (registry/skills.sh entries on a fresh clone). Defaults to
   * the process-wide `defaultRegistry`; tests inject fakes.
   */
  registry?: ProviderRegistry
}

export async function reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  const fs = options.filesystem ?? new FilesystemService()
  const strategy = options.linkStrategy ?? 'auto'
  const resolvedStrategy = resolveLinkStrategy(strategy)

  const manifest = await readManifest(options.repositoryRoot)
  const lockfile = await readLockfileOrEmpty(options.repositoryRoot)

  const ownership = new RuntimeOwnershipResolver({
    managedRoot: options.library.libraryRoot,
    links: options.linkState,
  })

  let changed = false
  const skills: ReconcileSkillReport[] = []
  const problems: ReconcileProblem[] = []
  const nextLockedSkills: SkillboxLockfile['skills'] = { ...lockfile.skills }
  const assignedByAlias = new Map<string, string[]>()

  const git = options.git ?? new GitClient()
  const remoteRoot = options.remoteRoot ?? remoteMaterializeRoot(options.library.libraryRoot)

  for (const [alias, skill] of Object.entries(manifest.skills)) {
    const mode = deriveMode(skill)
    const desiredAgents = desiredAgentsFor(skill, manifest)
    assignedByAlias.set(alias, desiredAgents)

    let sourcePath: string
    let revision: string | undefined

    if (skill.source.type === 'local') {
      try {
        sourcePath = resolveInsideRoot(options.repositoryRoot, skill.source.path)
      } catch (error) {
        problems.push({
          code: ErrorCode.INVALID_MANIFEST,
          alias,
          message: `Unresolvable local path "${skill.source.path}": ${String(error)}`,
        })
        skills.push({
          alias,
          mode,
          status: 'broken',
          message: `path "${skill.source.path}" is not a valid local path`,
        })
        continue
      }

      if (!(await isDirectory(sourcePath, fs))) {
        problems.push({
          code: ErrorCode.SKILL_MISSING,
          alias,
          message: `Local skill directory missing: ${sourcePath}`,
        })
        skills.push({ alias, mode, status: 'missing', sourcePath, message: 'directory missing' })
        continue
      }
    } else {
      const outcome = await resolveRemoteSource({
        alias,
        skill,
        mode,
        filesystem: fs,
        git,
        remoteRoot,
        ...(options.registry === undefined ? {} : { registry: options.registry }),
      })
      if (!outcome.ok) {
        if (outcome.problem !== undefined) {
          problems.push(outcome.problem)
        }
        skills.push(outcome.report)
        continue
      }
      sourcePath = outcome.sourcePath
      revision = outcome.revision
    }

    const skillMarkdown = path.join(sourcePath, 'SKILL.md')
    if (!(await fs.exists(skillMarkdown))) {
      problems.push({
        code: ErrorCode.SKILL_BROKEN,
        alias,
        message: `Skill directory has no SKILL.md: ${sourcePath}`,
      })
      skills.push({ alias, mode, status: 'broken', sourcePath, message: 'missing SKILL.md' })
      continue
    }

    const integrity = await computeSkillIntegrity(sourcePath)
    const locked = lockfile.skills[alias]
    const lockedIntegrity = locked?.integrity

    const materialized = await options.library.materializeSkill({
      alias,
      mode,
      source: sourcePath,
    })
    changed = changed || materialized.status !== 'unchanged'
    nextLockedSkills[alias] = createLockedSkill({
      mode,
      source: skill.source,
      integrity,
      ...(revision !== undefined ? { revision } : {}),
    })

    const linkReports: ReconcileSkillLinkReport[] = []
    for (const agentId of desiredAgents) {
      const adapter = options.adapters?.get(agentId)
      if (adapter === undefined) {
        linkReports.push({ agent: agentId, action: 'missing_adapter', changed: false })
        continue
      }
      const outcome = await linkSkillToAgent({
        adapter,
        agentId,
        alias,
        source: materialized.path,
        strategy,
        ownership,
        links: options.linkState,
        filesystem: fs,
      })
      linkReports.push({
        agent: agentId,
        action: outcome.action,
        changed: outcome.changed,
        ...(outcome.path !== undefined ? { path: outcome.path } : {}),
      })
      changed = changed || outcome.changed
    }

    const report: ReconcileSkillReport = {
      alias,
      mode,
      status: 'ok',
      sourcePath,
      integrity,
      materialized: materialized.status !== 'unchanged',
      materializeStatus: materialized.status,
      materializedPath: materialized.path,
      links: linkReports,
    }
    if (revision !== undefined) {
      report.revision = revision
    }
    if (lockedIntegrity !== undefined) {
      report.lockIntegrity = lockedIntegrity
    }
    report.integrityValid = lockedIntegrity === undefined || lockedIntegrity === integrity
    if (lockedIntegrity !== undefined && lockedIntegrity !== integrity) {
      problems.push({
        code: ErrorCode.INTEGRITY_MISMATCH,
        alias,
        message: `Locked integrity ${lockedIntegrity} differs from repository ${integrity}`,
      })
    }
    skills.push(report)
  }

  const staleState = await cleanupStaleLinks({
    linkState: options.linkState,
    assignedByAlias,
    filesystem: fs,
  })
  changed = changed || staleState.changed

  const nextLock: SkillboxLockfile = {
    lockfileVersion: lockfile.lockfileVersion,
    skills: nextLockedSkills,
  }
  if (lockfile.generatedBy !== undefined) {
    nextLock.generatedBy = lockfile.generatedBy
  }
  const lockChanged = await writeLockfileIfChanged(options.repositoryRoot, nextLock)
  changed = changed || lockChanged

  const agents = await buildAgentReports(options, fs)

  return {
    changed,
    repository: options.repositoryRoot,
    linkStrategy: resolvedStrategy,
    skills,
    staleLinks: staleState.reports,
    agents,
    problems,
  }
}

/** Outcome of resolving a remote skill's local source directory. */
type RemoteResolveOutcome =
  | { ok: true; sourcePath: string; revision: string }
  | { ok: false; report: ReconcileSkillReport; problem?: ReconcileProblem }

/**
 * Materializes the local source of a remote (managed) skill. Git-clone-able
 * sources (github / git) go through the git mirror; registry sources
 * (skills.sh) fall back to the registry provider framework, which downloads
 * the skill subtree directly.
 */
async function resolveRemoteSource(input: {
  alias: string
  skill: ManifestSkill
  mode: SkillMode
  filesystem: FilesystemService
  git: GitClient
  remoteRoot: string
  registry?: ProviderRegistry
}): Promise<RemoteResolveOutcome> {
  const source = input.skill.source
  const plan = planRemoteSource(source)
  if (plan === undefined) {
    return resolveRegistrySource(input)
  }

  const targetDir = path.join(input.remoteRoot, plan.key)
  let materialized: GitMaterializeResult
  try {
    const materializeOptions: GitMaterializeOptions = { url: plan.url, targetDir }
    if (plan.ref !== undefined) {
      materializeOptions.ref = plan.ref
    }
    materialized = await input.git.materialize(materializeOptions)
  } catch (error) {
    if (error instanceof SkillboxError && error.code === ErrorCode.GIT_NOT_FOUND) {
      const message = 'git is not installed; remote sources cannot be materialized'
      return {
        ok: false,
        report: { alias: input.alias, mode: input.mode, status: 'broken', message },
        problem: {
          code: ErrorCode.GIT_NOT_FOUND,
          alias: input.alias,
          message: `${message} (needed for ${plan.url})`,
        },
      }
    }
    if (error instanceof SkillboxError && error.code === ErrorCode.GIT_COMMAND_FAILED) {
      const message = `remote materialize failed: ${error.message}`
      return {
        ok: false,
        report: { alias: input.alias, mode: input.mode, status: 'broken', message },
        problem: {
          code: ErrorCode.GIT_COMMAND_FAILED,
          alias: input.alias,
          message: `Failed to materialize ${plan.url} (${error.message})`,
        },
      }
    }
    throw error
  }

  let sourcePath = targetDir
  const subPath = source.type === 'git' || source.type === 'github' ? source.path : undefined
  if (subPath !== undefined) {
    try {
      sourcePath = resolveInsideRoot(targetDir, subPath)
    } catch {
      const message = `unresolvable source path "${subPath}" in ${plan.url}`
      return {
        ok: false,
        report: {
          alias: input.alias,
          mode: input.mode,
          status: 'broken',
          sourcePath: targetDir,
          message,
        },
        problem: { code: ErrorCode.INVALID_MANIFEST, alias: input.alias, message },
      }
    }
  }

  if (!(await isDirectory(sourcePath, input.filesystem))) {
    const message = 'remote skill directory missing after materialize'
    return {
      ok: false,
      report: { alias: input.alias, mode: input.mode, status: 'missing', sourcePath, message },
      problem: {
        code: ErrorCode.SKILL_MISSING,
        alias: input.alias,
        message: `${message}: ${sourcePath}`,
      },
    }
  }

  return { ok: true, sourcePath, revision: materialized.headRev }
}

/**
 * Materializes a registry-type source (skills.sh) through the registry
 * provider framework: resolve pins the revision, `download()` materializes the
 * skill subtree into a local mirror under the remote root.
 */
async function resolveRegistrySource(input: {
  alias: string
  skill: ManifestSkill
  mode: SkillMode
  filesystem: FilesystemService
  remoteRoot: string
  registry?: ProviderRegistry
}): Promise<RemoteResolveOutcome> {
  const source = input.skill.source
  const report = (
    status: ReconcileSkillStatus,
    message: string,
    problem?: ReconcileProblem,
  ): RemoteResolveOutcome => ({
    ok: false,
    report: { alias: input.alias, mode: input.mode, status, message },
    ...(problem === undefined ? {} : { problem }),
  })

  const normalized = fromManifestSource(source)
  if (normalized === null) {
    return report(
      'skipped',
      `source type "${source.type}" (registry "${'registry' in source ? source.registry : '?'}") has no registry representation yet`,
    )
  }
  const registry = input.registry
  if (registry === undefined || !registry.hasProvider(normalized.type)) {
    return report(
      'skipped',
      `registry source needs a "${normalized.type}" provider to materialize; run \`skillbox add\` to install it`,
    )
  }
  const provider = registry.resolveProvider(normalized.type)
  let revision: string
  try {
    const resolved = await provider.resolve(normalized)
    revision = resolved.revision
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return report('broken', `registry resolve failed: ${message}`, {
      code: ErrorCode.INSTALL_SOURCE_UNRESOLVED,
      alias: input.alias,
      message,
    })
  }

  const targetDir = path.join(input.remoteRoot, `registry-${input.alias}`)
  try {
    // Providers materialize the skill subtree directly into `targetDir`.
    await provider.download(normalized, revision, targetDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return report('broken', `registry download failed: ${message}`, {
      code: ErrorCode.INSTALL_DOWNLOAD_FAILED,
      alias: input.alias,
      message,
    })
  }

  if (!(await isDirectory(targetDir, input.filesystem))) {
    return report('missing', 'registry download produced no skill directory', {
      code: ErrorCode.SKILL_MISSING,
      alias: input.alias,
      message: `no skill directory at ${targetDir}`,
    })
  }
  return { ok: true, sourcePath: targetDir, revision }
}

async function isDirectory(target: string, fs: FilesystemService): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function readLockfileOrEmpty(root: string): Promise<SkillboxLockfile> {
  try {
    return await readLockfile(root)
  } catch (error) {
    if (error instanceof SkillboxError && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
      return emptyLockfile()
    }
    throw error
  }
}

/**
 * Resolves the agents a skill is assigned to (M7.3): an explicit skill-level
 * `agents` list wins; otherwise `settings.defaultAgents`; otherwise none.
 * Agent ids explicitly disabled in `manifest.agents` are filtered out.
 */
function desiredAgentsFor(skill: ManifestSkill, manifest: SkillboxManifest): string[] {
  const candidates = skill.agents ?? manifest.settings?.defaultAgents ?? []
  const agentConfig = manifest.agents ?? {}
  return candidates.filter((agentId: string) => {
    const config = agentConfig[agentId]
    return config === undefined || config.enabled !== false
  })
}

async function cleanupStaleLinks(input: {
  linkState: RuntimeLinkState
  assignedByAlias: Map<string, string[]>
  filesystem: FilesystemService
}): Promise<{ reports: ReconcileStaleLinkReport[]; changed: boolean }> {
  const database = await input.linkState.load()
  const reports: ReconcileStaleLinkReport[] = []
  let changed = false
  for (const [agent, row] of Object.entries(database)) {
    for (const [alias, record] of Object.entries(row)) {
      const desired = input.assignedByAlias.get(alias)?.includes(agent) ?? false
      if (desired) {
        continue
      }
      const action = await removeStaleSkillLink({
        target: record.target,
        source: record.source,
        filesystem: input.filesystem,
      })
      const { changed: stateChanged } = await input.linkState.remove(agent, alias)
      changed = changed || stateChanged || action === 'removed'
      reports.push({ agent, alias, action, stateChanged })
    }
  }
  return { reports, changed }
}

async function buildAgentReports(
  options: ReconcileOptions,
  fs: FilesystemService,
): Promise<ReconcileAgentReport[]> {
  const reports: ReconcileAgentReport[] = []
  for (const adapter of options.adapters?.values() ?? []) {
    const dirs = await adapter.getSkillDirectories()
    const primary = dirs[0]
    const dirExists = primary === undefined ? false : await fs.exists(primary)
    reports.push({ agent: adapter.id, skillDirectories: dirs, dirExists })
  }
  return reports
}
