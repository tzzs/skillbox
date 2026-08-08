import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { ErrorCode, isSkillboxError, SkillboxError } from '../errors.js'
import {
  addSkill,
  emptyManifest,
  readManifest,
  updateSkill,
  writeManifest,
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
import type { AgentAdapter } from '../agent/adapter.js'
import type { LinkStrategy } from '../fs/links.js'
import { RuntimeLibraryService } from './library.js'
import { RuntimeLinkState } from './links.js'
import { RuntimeOwnershipResolver } from './ownership.js'
import { linkSkillToAgent, type LinkAction } from './linker.js'

/** Import mode for the first wave: unknown origins are `local` (spec §134). */
export type ImportMode = 'local'

export interface SkillImportRequest {
  /** Absolute path of the external skill directory to import. */
  sourceDir: string
  /** Alias to import under; defaults to the source directory basename. */
  alias?: string
  /** Repository root owning `skills/`, `skillbox.yaml` and `skillbox.lock`. */
  repositoryRoot: string
  /** Import mode. Only `local` is supported in the first wave. */
  mode?: 'local'
  /** Runtime library the imported skill is materialized into. */
  library: RuntimeLibraryService
  /**
   * Required when `migrateAgents` is used; records created managed links so
   * Reconcile can recognize them safely.
   */
  linkState?: RuntimeLinkState
  /** Requested link strategy for created runtime links. */
  linkStrategy?: LinkStrategy
  /** Agent adapters by id, used only when agents migrate. */
  adapters?: ReadonlyMap<string, AgentAdapter>
  /**
   * Agent ids whose external entry named after this alias should be replaced
   * by a managed link (M6.5 final step). The imported repository copy
   * guarantees the original skill content is never lost.
   */
  migrateAgents?: string[]
  /** Filesystem to use; defaults to the real one. */
  filesystem?: FilesystemService
}

/** M6.6 — caller-chosen resolution for a detected conflict. */
export type ImportDecision =
  | { kind: 'use-existing' }
  | { kind: 'import-incoming' }
  | { kind: 'import-both'; alias?: string }
  | { kind: 'skip' }

export type ImportConflictKind = 'manifest' | 'dir' | 'link'

export interface ImportConflictInfo {
  alias: string
  kind: ImportConflictKind
  incomingIntegrity: string
  existingIntegrity?: string
  /** Agent whose external entry collides with the imported alias (kind `link`). */
  agent?: string
  /** Concrete choices the caller may pass back via the `decision` argument. */
  decisions: ImportDecision[]
}

export type ImportResultStatus = 'imported' | 'unchanged' | 'kept-existing' | 'skipped' | 'conflict'

export interface ImportLinkOutcome {
  agent: string
  action: LinkAction
}

export interface ImportResult {
  status: ImportResultStatus
  alias?: string
  /** Absolute repository path of the imported copy. */
  repositoryPath?: string
  integrity?: string
  /** Absolute materialized library copy path. */
  materializedPath?: string
  /** True when the import produced any on-disk change. */
  changed: boolean
  links?: ImportLinkOutcome[]
  conflicts?: ImportConflictInfo[]
}

/** Default alias: the source directory basename (safe fallback `skill`). */
export function defaultSkillAlias(sourceDir: string): string {
  const base = path.basename(sourceDir.replace(/[\\/]+$/, ''))
  return base.length > 0 && base !== '.' ? base : 'skill'
}

function repoSkillsDir(root: string): string {
  return resolveInsideRoot(root, 'skills')
}

/** Manifest source record for an imported (local) skill. */
function localSource(alias: string): { type: 'local'; path: string } {
  return { type: 'local', path: `skills/${alias}` }
}

async function readManifestOrEmpty(root: string): Promise<SkillboxManifest> {
  try {
    return await readManifest(root)
  } catch (error) {
    if (isSkillboxError(error) && error.code === ErrorCode.MANIFEST_NOT_FOUND) {
      return emptyManifest()
    }
    throw error
  }
}

async function readLockfileOrEmpty(root: string): Promise<SkillboxLockfile> {
  try {
    return await readLockfile(root)
  } catch (error) {
    if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
      return emptyLockfile()
    }
    throw error
  }
}

/** The repository-local directory meant for this alias. */
async function entityDirPath(
  entry: ManifestSkill | undefined,
  root: string,
  alias: string,
): Promise<string> {
  if (entry !== undefined && entry.source.type === 'local' && entry.source.path !== undefined) {
    return resolveInsideRoot(root, entry.source.path)
  }
  return path.join(repoSkillsDir(root), alias)
}

async function isDir(targetPath: string, fs: FilesystemService): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory()
  } catch {
    return false
  }
}

async function optionalIntegrity(targetDir: string): Promise<string | undefined> {
  try {
    return await computeSkillIntegrity(targetDir)
  } catch {
    return undefined
  }
}

interface RepoState {
  manifest: SkillboxManifest
  entry: ManifestSkill | undefined
  targetDir: string
  dirExists: boolean
  dirIntegrity: string | undefined
}

async function repoState(
  alias: string,
  request: SkillImportRequest,
  fs: FilesystemService,
): Promise<RepoState> {
  const manifest = await readManifestOrEmpty(request.repositoryRoot)
  const entry = manifest.skills[alias]
  const targetDir = await entityDirPath(entry, request.repositoryRoot, alias)
  const dirExists = await isDir(targetDir, fs)
  const dirIntegrity = dirExists ? await optionalIntegrity(targetDir) : undefined
  return { manifest, entry, targetDir, dirExists, dirIntegrity }
}

async function pickFreshAlias(
  base: string,
  request: SkillImportRequest,
  fs: FilesystemService,
): Promise<string> {
  let suffix = 2
  for (;;) {
    const candidate = `${base}-${suffix}`
    const manifest = await readManifestOrEmpty(request.repositoryRoot)
    const candidateDir = path.join(repoSkillsDir(request.repositoryRoot), candidate)
    if (manifest.skills[candidate] === undefined && !(await isDir(candidateDir, fs))) {
      return candidate
    }
    suffix += 1
  }
}

function conflictInfo(args: {
  alias: string
  kind: ImportConflictKind
  incomingIntegrity: string
  existingIntegrity: string | undefined
  agent?: string
}): ImportConflictInfo {
  const info: ImportConflictInfo = {
    alias: args.alias,
    kind: args.kind,
    incomingIntegrity: args.incomingIntegrity,
    decisions: [
      { kind: 'use-existing' },
      { kind: 'import-incoming' },
      { kind: 'import-both', alias: `${args.alias}-2` },
      { kind: 'skip' },
    ],
  }
  if (args.existingIntegrity !== undefined) {
    info.existingIntegrity = args.existingIntegrity
  }
  if (args.agent !== undefined) {
    info.agent = args.agent
  }
  return info
}

/** Detects M6.6 conflicts: existing alias/entry with different content. */
function findConflicts(state: RepoState, incomingIntegrity: string): ImportConflictInfo[] {
  const same = state.dirExists && state.dirIntegrity === incomingIntegrity
  if (state.entry !== undefined && state.dirExists && !same) {
    return [
      conflictInfo({
        alias: '',
        kind: 'manifest',
        incomingIntegrity,
        existingIntegrity: state.dirIntegrity,
      }),
    ]
  }
  if (state.entry === undefined && state.dirExists && !same) {
    return [
      conflictInfo({
        alias: '',
        kind: 'dir',
        incomingIntegrity,
        existingIntegrity: state.dirIntegrity,
      }),
    ]
  }
  return []
}

async function importIntoRepository(
  request: SkillImportRequest,
  fs: FilesystemService,
  alias: string,
  incomingIntegrity: string,
  state: RepoState,
  overwriteContent: boolean,
): Promise<{ repositoryPath: string; lockChanged: boolean; materializedPath: string }> {
  const targetDir = state.targetDir
  const identical = state.dirExists && state.dirIntegrity === incomingIntegrity
  if (state.dirExists && !identical) {
    await fs.remove(targetDir)
  }
  if (overwriteContent || !identical) {
    await fs.copy(request.sourceDir, targetDir)
  }

  const manifest = await readManifestOrEmpty(request.repositoryRoot)
  const source = localSource(alias)
  const mode = 'local' as const
  const next =
    manifest.skills[alias] === undefined
      ? addSkill(manifest, alias, { source, mode })
      : updateSkill(manifest, alias, { source, mode })
  await writeManifest(request.repositoryRoot, next)

  const lock = await readLockfileOrEmpty(request.repositoryRoot)
  lock.skills[alias] = createLockedSkill({
    mode,
    source: localSource(alias),
    integrity: incomingIntegrity,
  })
  const lockChanged = await writeLockfileIfChanged(request.repositoryRoot, lock)

  const materialized = await request.library.materializeSkill({
    alias,
    mode,
    source: targetDir,
  })
  return { repositoryPath: targetDir, lockChanged, materializedPath: materialized.path }
}

/**
 * Replaces external agent entries (named after `alias`) with managed links to
 * the just-materialized library copy (M6.5). A genuinely different external
 * skill of the same name is never clobbered: it surfaces as a `link` conflict.
 */
async function migrateAgentLinks(
  request: SkillImportRequest,
  fs: FilesystemService,
  alias: string,
  incomingIntegrity: string,
  materializedPath: string,
): Promise<{ links: ImportLinkOutcome[]; changed: boolean; linkConflict?: ImportConflictInfo }> {
  const outcomes: ImportLinkOutcome[] = []
  if (request.linkState === undefined) {
    throw new SkillboxError(
      ErrorCode.INVALID_LINK_STATE,
      'linkState is required when migrateAgents is used',
    )
  }
  const ownership = new RuntimeOwnershipResolver({
    managedRoot: request.library.libraryRoot,
    links: request.linkState,
  })
  let changed = false
  for (const agentId of request.migrateAgents ?? []) {
    const adapter = request.adapters?.get(agentId)
    if (adapter === undefined) {
      outcomes.push({ agent: agentId, action: 'missing_adapter' })
      continue
    }
    const dirs = await adapter.getSkillDirectories()
    const dir = dirs[0]
    if (dir === undefined) {
      outcomes.push({ agent: agentId, action: 'no_dir' })
      continue
    }
    const destination = path.join(dir, alias)
    if (await fs.exists(destination)) {
      const ownedSkill = await ownership.isSkillboxOwned(destination)
      if (!ownedSkill) {
        const externalIntegrity = await optionalIntegrity(destination)
        if (externalIntegrity !== undefined && externalIntegrity !== incomingIntegrity) {
          return {
            links: outcomes,
            changed: false,
            linkConflict: conflictInfo({
              alias,
              kind: 'link',
              incomingIntegrity,
              existingIntegrity: externalIntegrity,
              agent: agentId,
            }),
          }
        }
        await fs.remove(destination)
      }
    }
    const linked = await linkSkillToAgent({
      adapter,
      agentId,
      alias,
      source: materializedPath,
      strategy: request.linkStrategy ?? 'auto',
      ownership,
      links: request.linkState,
      filesystem: fs,
    })
    outcomes.push({ agent: agentId, action: linked.action })
    changed = changed || linked.changed
  }
  return { links: outcomes, changed }
}

/**
 * M6.5 + M6.6 Import Existing Skill.
 *
 * Copies an external skill into `repository/skills/<alias>`, records it as a
 * `local` Manifest skill, locks its integrity, materializes it into the
 * runtime library and (optionally) replaces the external agent copy with a
 * managed link.
 *
 * When the alias already exists with different content the service never
 * silently merges: it returns a structured `conflict` and changes nothing.
 * Callers resolve by calling again with an explicit `decision` (use existing /
 * import incoming / import both under a fresh alias / skip).
 */
export async function importSkill(
  request: SkillImportRequest,
  decision?: ImportDecision,
): Promise<ImportResult> {
  const fs = request.filesystem ?? new FilesystemService()
  const requestedAlias = request.alias ?? defaultSkillAlias(request.sourceDir)

  if (!(await fs.exists(request.sourceDir))) {
    throw new SkillboxError(
      ErrorCode.SKILL_MISSING,
      `Source skill not found at "${request.sourceDir}"`,
      { context: { source: request.sourceDir, alias: requestedAlias } },
    )
  }
  const incomingIntegrity = await computeSkillIntegrity(request.sourceDir)

  if (decision !== undefined && decision.kind === 'skip') {
    return { status: 'skipped', alias: requestedAlias, changed: false }
  }
  if (decision !== undefined && decision.kind === 'use-existing') {
    return { status: 'kept-existing', alias: requestedAlias, changed: false }
  }

  let targetAlias = requestedAlias
  let importingOverExternal = false
  if (decision !== undefined && decision.kind === 'import-incoming') {
    importingOverExternal = true
  }
  if (decision !== undefined && decision.kind === 'import-both') {
    targetAlias = decision.alias ?? (await pickFreshAlias(requestedAlias, request, fs))
  }

  const state = await repoState(targetAlias, request, fs)
  const identical = state.dirExists && state.dirIntegrity === incomingIntegrity

  if (decision === undefined) {
    const conflicts = findConflicts(state, incomingIntegrity)
    if (conflicts.length > 0) {
      return {
        status: 'conflict',
        alias: targetAlias,
        conflicts: conflicts.map((conflict) => ({ ...conflict, alias: targetAlias })),
        changed: false,
      }
    }
    if (state.entry !== undefined && identical) {
      return {
        status: 'unchanged',
        alias: targetAlias,
        repositoryPath: state.targetDir,
        integrity: incomingIntegrity,
        changed: false,
      }
    }
  }

  const imported = await importIntoRepository(
    request,
    fs,
    targetAlias,
    incomingIntegrity,
    state,
    importingOverExternal,
  )

  let links: ImportLinkOutcome[] | undefined
  let linkChanged = false
  if ((request.migrateAgents?.length ?? 0) > 0) {
    const migration = await migrateAgentLinks(
      request,
      fs,
      targetAlias,
      incomingIntegrity,
      imported.materializedPath,
    )
    links = migration.links
    linkChanged = migration.changed
    if (migration.linkConflict !== undefined) {
      return {
        status: 'conflict',
        alias: targetAlias,
        conflicts: [{ ...migration.linkConflict, alias: targetAlias }],
        changed: false,
      }
    }
  }

  const result: ImportResult = {
    status: 'imported',
    alias: targetAlias,
    repositoryPath: imported.repositoryPath,
    integrity: incomingIntegrity,
    materializedPath: imported.materializedPath,
    changed: imported.lockChanged || linkChanged,
  }
  if (links !== undefined) {
    result.links = links
  }
  return result
}
