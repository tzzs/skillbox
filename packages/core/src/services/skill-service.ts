import * as path from 'node:path'
import type { AgentAdapter, AgentRegistry } from '../agent/index.js'
import type { LinkStrategy } from '../fs/links.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { ErrorCode, isSkillboxError, SkillboxError } from '../errors.js'
import {
  addSkill,
  deriveMode,
  emptyManifest,
  readManifest,
  removeSkill,
  setAgents,
  validateSkillAlias,
  writeManifest,
  type SkillboxManifest,
} from '../manifest/index.js'
import {
  createLockedSkill,
  emptyLockfile,
  readLockfile,
  writeLockfileIfChanged,
  type SkillboxLockfile,
} from '../lockfile/index.js'
import { reconcile, type ReconcileOptions, type ReconcileResult } from '../reconcile/index.js'
import { RuntimeLibraryService, type MaterializeSkillResult } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { createOperationRuntime, type OperationRuntime } from '../operations/runtime.js'
import {
  importSkill as importSkillIntoRepository,
  type ImportDecision,
  type ImportResult,
} from '../runtime/import.js'

export const DEFAULT_SKILL_MARKDOWN = (alias: string, description?: string): string => `# ${alias}

${description === undefined ? 'A Skillbox skill.' : description}
`

export interface SkillServiceOptions {
  repositoryRoot: string
  /** Skillbox home root; library + links state are derived from it. */
  homeRoot: string
  registry?: AgentRegistry
  filesystem?: FilesystemService
  linkStrategy?: LinkStrategy
  operationRuntime?: OperationRuntime
}

export interface CreateSkillResult {
  name: string
  /** Absolute path of the created `skills/<name>` directory. */
  path: string
  manifestWritten: boolean
  lockfileWritten: boolean
  materialized: MaterializeSkillResult
}

export interface RemoveSkillResult {
  name: string
  /** Mode the skill was removed in. */
  mode: string
  manifestWritten: boolean
  lockfileWritten: boolean
  libraryRemoved: boolean
  /** True when `--delete-files` removed the on-disk skill directory. */
  filesRemoved: boolean
  /** Absolute path of the removed skill directory (when files were removed). */
  filesPath?: string
}

export interface AgentAssignmentResult {
  name: string
  agent: string
  manifestChanged: boolean
  reconcile: ReconcileResult
}

/**
 * M8 high-level skill lifecycle operations used by the CLI.
 *
 * Every mutation goes through Core primitives (Manifest, Lockfile, Reconcile,
 * Runtime Library); the CLI never touches skill files directly.
 */
/**
 * The set of agents a skill is currently enabled for: the explicit skill-level
 * `agents` array wins, otherwise `settings.defaultAgents` applies.
 */
function effectiveAgents(
  entry: SkillboxManifest['skills'][string],
  manifest: SkillboxManifest,
): string[] {
  return entry.agents ?? manifest.settings?.defaultAgents ?? []
}
export class SkillService {
  private readonly filesystem: FilesystemService
  private readonly repositoryRoot: string
  private readonly homeRoot: string
  private readonly registry: AgentRegistry | undefined
  private readonly linkStrategy: LinkStrategy | undefined
  private readonly operationRuntime: OperationRuntime | undefined

  constructor(options: SkillServiceOptions) {
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.repositoryRoot = options.repositoryRoot
    this.homeRoot = options.homeRoot
    this.registry = options.registry
    this.linkStrategy = options.linkStrategy
    this.operationRuntime = options.operationRuntime
  }

  private get homeLayout() {
    return buildSkillboxHomeLayout(this.homeRoot)
  }

  private library(): RuntimeLibraryService {
    return new RuntimeLibraryService(this.homeLayout.library, this.filesystem)
  }

  private linkState(): RuntimeLinkState {
    return new RuntimeLinkState({
      filePath: this.homeLayout.linksFile,
      filesystem: this.filesystem,
    })
  }

  private adapters(): Map<string, AgentAdapter> {
    const registry = this.registry?.list() ?? []
    return new Map(registry.map((adapter) => [adapter.id, adapter]))
  }

  private async ensureHome(): Promise<void> {
    await this.filesystem.mkdir(this.homeLayout.root)
    await this.filesystem.mkdir(this.homeLayout.library)
    await this.filesystem.mkdir(this.homeLayout.state)
  }

  /** Runs the Reconcile engine against this repository + home. */
  private runReconcile(): Promise<ReconcileResult> {
    const options: ReconcileOptions = {
      repositoryRoot: this.repositoryRoot,
      library: this.library(),
      linkState: this.linkState(),
      adapters: this.adapters(),
    }
    if (this.linkStrategy !== undefined) {
      options.linkStrategy = this.linkStrategy
    }
    return reconcile(options)
  }

  private async readManifestRequired(): Promise<SkillboxManifest> {
    return readManifest(this.repositoryRoot)
  }

  private async readManifestOrEmpty(): Promise<SkillboxManifest> {
    try {
      return await readManifest(this.repositoryRoot)
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.MANIFEST_NOT_FOUND) {
        return emptyManifest()
      }
      throw error
    }
  }

  private async readLockfileOrEmpty(): Promise<SkillboxLockfile> {
    try {
      return await readLockfile(this.repositoryRoot)
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
        return emptyLockfile()
      }
      throw error
    }
  }

  /**
   * Scaffolds `skills/<name>/SKILL.md`, adds the skill to the Manifest, locks
   * it, and materializes it into the Runtime Library immediately.
   */
  async createSkill(input: { name: string; description?: string }): Promise<CreateSkillResult> {
    const alias = validateSkillAlias(input.name)
    await this.ensureHome()

    const manifest = await this.readManifestOrEmpty()
    if (manifest.skills[alias] !== undefined) {
      throw new SkillboxError(
        ErrorCode.IMPORT_CONFLICT,
        `Skill "${alias}" is already declared in the manifest`,
        { context: { alias } },
      )
    }

    const skillDir = resolveInsideRoot(this.repositoryRoot, `skills/${alias}`)
    if (await this.filesystem.exists(skillDir)) {
      throw new SkillboxError(
        ErrorCode.IMPORT_CONFLICT,
        `A directory already exists at "${skillDir}"`,
        { context: { alias, path: skillDir } },
      )
    }

    await this.filesystem.mkdir(skillDir)
    await this.filesystem.writeFile(
      path.join(skillDir, 'SKILL.md'),
      DEFAULT_SKILL_MARKDOWN(alias, input.description),
    )

    const integrity = await computeSkillIntegrity(skillDir)
    const source = { type: 'local' as const, path: `skills/${alias}` }
    const mode = 'local' as const

    const nextManifest = addSkill(manifest, alias, { source, mode })
    await writeManifest(this.repositoryRoot, nextManifest)

    const lockfile = await this.readLockfileOrEmpty()
    lockfile.skills[alias] = createLockedSkill({ mode, source, integrity })
    const lockfileWritten = await writeLockfileIfChanged(this.repositoryRoot, lockfile)

    const materialized = await this.library().materializeSkill({
      alias,
      mode,
      source: skillDir,
    })

    return {
      name: alias,
      path: skillDir,
      manifestWritten: true,
      lockfileWritten,
      materialized,
    }
  }

  /**
   * Removes a skill from the Manifest + Lockfile and its materialized library
   * copy. With `deleteFiles` the on-disk `skills/<name>` directory is removed
   * as well; otherwise the files are kept (config-only removal).
   */
  async removeSkill(input: { name: string; deleteFiles?: boolean }): Promise<RemoveSkillResult> {
    const alias = validateSkillAlias(input.name)
    await this.ensureHome()

    const manifest = await this.readManifestRequired()
    const entry = manifest.skills[alias]
    if (entry === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${alias}" is not in the manifest`,
        {
          context: { alias },
        },
      )
    }
    const mode = deriveMode(entry)

    const sourcePath =
      input.deleteFiles === true
        ? entry.source.type === 'local'
          ? resolveInsideRoot(this.repositoryRoot, entry.source.path)
          : resolveInsideRoot(this.repositoryRoot, `skills/${alias}`)
        : undefined
    const operationRuntime =
      this.operationRuntime ??
      createOperationRuntime({ repositoryRoot: this.repositoryRoot, homeRoot: this.homeRoot })
    const operation = await operationRuntime.runExclusive({
      kind: 'remove',
      targets: [
        path.join(this.repositoryRoot, 'skillbox.yaml'),
        path.join(this.repositoryRoot, 'skillbox.lock'),
        this.library().pathFor(alias, mode),
        ...(sourcePath === undefined ? [] : [sourcePath]),
      ],
      execute: () => this.removeSkillUnsafe(alias, mode, input, sourcePath),
    })
    return operation.result
  }

  private async removeSkillUnsafe(
    alias: string,
    mode: ReturnType<typeof deriveMode>,
    input: { name: string; deleteFiles?: boolean },
    sourcePath: string | undefined,
  ): Promise<RemoveSkillResult> {
    const manifest = await this.readManifestRequired()

    const nextManifest = removeSkill(manifest, alias)
    await writeManifest(this.repositoryRoot, nextManifest)

    const lockfile = await this.readLockfileOrEmpty()
    delete lockfile.skills[alias]
    const lockfileWritten = await writeLockfileIfChanged(this.repositoryRoot, lockfile)

    const libraryResult = await this.library().remove(alias, mode)

    let filesRemoved = false
    let filesPath: string | undefined
    if (input.deleteFiles === true) {
      if (sourcePath !== undefined && (await this.filesystem.exists(sourcePath))) {
        await this.filesystem.remove(sourcePath)
        filesRemoved = true
        filesPath = sourcePath
      }
    }

    const result: RemoveSkillResult = {
      name: alias,
      mode,
      manifestWritten: true,
      lockfileWritten,
      libraryRemoved: libraryResult.removed,
      filesRemoved,
    }
    if (filesPath !== undefined) {
      result.filesPath = filesPath
    }
    return result
  }

  /**
   * Enables a skill for an agent: adds the agent to the skill's `agents` list
   * and reconciles so the agent directory entry is created.
   */
  async enableSkill(input: { name: string; agent: string }): Promise<AgentAssignmentResult> {
    const alias = validateSkillAlias(input.name)
    await this.ensureHome()

    if (this.adapters().get(input.agent) === undefined) {
      throw new SkillboxError(ErrorCode.AGENT_NOT_FOUND, `Unknown agent "${input.agent}"`, {
        context: { agent: input.agent },
      })
    }

    const manifest = await this.readManifestRequired()
    const entry = manifest.skills[alias]
    if (entry === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${alias}" is not in the manifest`,
        {
          context: { alias },
        },
      )
    }

    const current = effectiveAgents(entry, manifest)
    let manifestChanged = false
    if (!current.includes(input.agent)) {
      const next = [...current, input.agent]
      await writeManifest(this.repositoryRoot, setAgents(manifest, alias, next))
      manifestChanged = true
    }

    return {
      name: alias,
      agent: input.agent,
      manifestChanged,
      reconcile: await this.runReconcile(),
    }
  }

  /**
   * Disables a skill for an agent: removes the agent from the skill's `agents`
   * list, then reconciles so the managed agent link is torn down.
   */
  async disableSkill(input: { name: string; agent: string }): Promise<AgentAssignmentResult> {
    const alias = validateSkillAlias(input.name)
    await this.ensureHome()

    const manifest = await this.readManifestRequired()
    const entry = manifest.skills[alias]
    if (entry === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${alias}" is not in the manifest`,
        {
          context: { alias },
        },
      )
    }

    const current = effectiveAgents(entry, manifest)
    let manifestChanged = false
    if (current.includes(input.agent)) {
      const next = current.filter((agent) => agent !== input.agent)
      await writeManifest(this.repositoryRoot, setAgents(manifest, alias, next))
      manifestChanged = true
    }

    return {
      name: alias,
      agent: input.agent,
      manifestChanged,
      reconcile: await this.runReconcile(),
    }
  }

  /** M8.8 Install/Restore: reconciles the current repository. */
  async install(): Promise<ReconcileResult> {
    await this.ensureHome()
    return this.runReconcile()
  }

  /**
   * Resolves the on-disk directory of a local skill. Local skills map to a
   * path under the repository; missing directories and broken skills throw a
   * typed error so callers can render a precise message.
   */
  private async resolveLocalSkillDirectory(alias: string): Promise<string> {
    const manifest = await this.readManifestRequired()
    const entry = manifest.skills[alias]
    if (entry === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${alias}" is not in the manifest`,
        { context: { alias } },
      )
    }
    if (entry.source.type !== 'local') {
      throw new SkillboxError(
        ErrorCode.SKILL_MISSING,
        `Skill "${alias}" has no local directory to edit`,
        { context: { alias } },
      )
    }
    let sourcePath: string
    try {
      sourcePath = resolveInsideRoot(this.repositoryRoot, entry.source.path)
    } catch (error) {
      throw new SkillboxError(
        ErrorCode.INVALID_MANIFEST,
        `Skill "${alias}" has an unresolvable local path`,
        { cause: error, context: { alias, path: entry.source.path } },
      )
    }
    if (!(await this.filesystem.exists(sourcePath))) {
      throw new SkillboxError(
        ErrorCode.SKILL_MISSING,
        `Skill directory not found at "${sourcePath}"`,
        { context: { alias, path: sourcePath } },
      )
    }
    if (!(await this.filesystem.exists(path.join(sourcePath, 'SKILL.md')))) {
      throw new SkillboxError(
        ErrorCode.SKILL_BROKEN,
        `Skill directory has no SKILL.md at "${sourcePath}"`,
        { context: { alias, path: sourcePath } },
      )
    }
    return sourcePath
  }

  /** M11.5 — reads the current `SKILL.md` of a local skill for the editor. */
  async readSkillMarkdown(input: { name: string }): Promise<{
    name: string
    /** Absolute path of the skill directory. */
    path: string
    /** Full content of `SKILL.md`. */
    markdown: string
  }> {
    const alias = validateSkillAlias(input.name)
    const sourcePath = await this.resolveLocalSkillDirectory(alias)
    const markdown = await this.filesystem.readFile(path.join(sourcePath, 'SKILL.md'))
    return { name: alias, path: sourcePath, markdown }
  }

  /**
   * Writes `SKILL.md` of a local skill and recomputes its integrity so the
   * Library/Detail views immediately reflect the `modified` state (M11.5).
   */
  async writeSkillMarkdown(input: { name: string; content: string }): Promise<{
    name: string
    /** Absolute path of the skill directory. */
    path: string
    /** Fresh integrity after the write. */
    integrity: string
    lockIntegrity?: string
    /** Status after the write: `ready` or `modified` (vs. the lockfile). */
    status: 'ready' | 'modified'
  }> {
    const alias = validateSkillAlias(input.name)
    const sourcePath = await this.resolveLocalSkillDirectory(alias)
    await this.filesystem.writeFile(path.join(sourcePath, 'SKILL.md'), input.content)

    const integrity = await computeSkillIntegrity(sourcePath)
    const lockfile = await this.readLockfileOrEmpty()
    const lockedIntegrity = lockfile.skills[alias]?.integrity

    const result: {
      name: string
      path: string
      integrity: string
      lockIntegrity?: string
      status: 'ready' | 'modified'
    } = {
      name: alias,
      path: sourcePath,
      integrity,
      status: lockedIntegrity === undefined || lockedIntegrity === integrity ? 'ready' : 'modified',
    }
    if (lockedIntegrity !== undefined) {
      result.lockIntegrity = lockedIntegrity
    }
    return result
  }

  /** M6.5/M6.6 Import an existing external skill into the repository. */
  async importExistingSkill(input: {
    name: string
    sourceDir: string
    migrateAgents?: string[]
    decision?: ImportDecision
  }): Promise<ImportResult> {
    const alias = validateSkillAlias(input.name)
    await this.ensureHome()

    const request: {
      sourceDir: string
      alias: string
      repositoryRoot: string
      library: RuntimeLibraryService
      linkState: RuntimeLinkState
      adapters: Map<string, AgentAdapter>
      linkStrategy: LinkStrategy
      filesystem: FilesystemService
      migrateAgents?: string[]
    } = {
      sourceDir: input.sourceDir,
      alias,
      repositoryRoot: this.repositoryRoot,
      library: this.library(),
      linkState: this.linkState(),
      adapters: this.adapters(),
      linkStrategy: this.linkStrategy ?? 'auto',
      filesystem: this.filesystem,
    }
    if (input.migrateAgents !== undefined) {
      request.migrateAgents = input.migrateAgents
    }

    return input.decision === undefined
      ? importSkillIntoRepository(request)
      : importSkillIntoRepository(request, input.decision)
  }
}
