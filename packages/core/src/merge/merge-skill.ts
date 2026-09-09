/**
 * M20.6/7 Skill-level merge orchestration: `mergeSkill()` / `continueMerge()` /
 * `abortMerge()`.
 *
 * `mergeSkill` resolves the three content views (base snapshot, current local
 * content, latest upstream), takes a pre-merge backup
 * (`<home>/backups/<alias>-<ts>/`), runs the pure tree merge, writes the
 * result into the skill's content directory and:
 * - clean merge → advances the lockfile metadata (`upstream.baseRevision` /
 *   `baseIntegrity` / `latestRevision`, and `revision` + `integrity` for
 *   managed skills), no merge state left behind;
 * - conflicted merge → persists the merge state
 *   (`<home>/state/merge/<alias>/` with base/local/upstream snapshots) and
 *   leaves the conflict markers in place for the user to resolve.
 *
 * `continueMerge` verifies every conflict file no longer contains markers and
 * then completes the metadata update (M20.4). `abortMerge` restores the
 * pre-merge local content from the state snapshot and clears the state.
 *
 * The result shapes match the CLI contract (`packages/cli/src/skill-lifecycle/
 * types.ts` `MergeResult` / `ContinueMergeResult` / `AbortMergeResult`).
 */
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { resolveSkillboxHome } from '../runtime/paths.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { readManifest, deriveMode } from '../manifest/index.js'
import type { ManifestSkill, SkillboxManifest } from '../manifest/schema.js'
import { readLockfile, writeLockfile } from '../lockfile/index.js'
import type { LockedSkill, LockedUpstream, SkillboxLockfile } from '../lockfile/schema.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import type { GitClient } from '../git/index.js'
import type { ProviderRegistry } from '../registry/index.js'
import { SkillContentResolver, scanSkillTree, type TreeEntry } from '../diff/sources.js'
import { containsConflictMarkers } from './merge.js'
import { mergeTrees, type BinaryMergePolicy } from './tree.js'
import {
  createBackup,
  countFilesIn,
  hasPendingMerge,
  loadMergeState,
  mergeStatePaths,
  removeMergeState,
  saveMergeState,
  type MergeStateRecord,
} from './state.js'

/** One conflicting file of a merge — mirror of the CLI's `MergeConflict`. */
export interface MergeSkillConflict {
  /** Portable relative path (forward slashes). */
  path: string
  /** Number of conflict hunks in this file. */
  hunks: number
  /** e.g. `binary` when the file was not auto-merged. */
  reason?: string
}

/** Result of a 3-way merge run — mirror of the CLI's `MergeResult`. */
export interface MergeSkillResult {
  name: string
  conflicts: MergeSkillConflict[]
  /** Files written by this merge that differ from the pre-merge content. */
  filesMerged: number
  /** Conflict hunks left in the content (0 for a clean merge). */
  changes: number
  /** New base revision after a clean merge (absent while conflicts remain). */
  baseRevision?: string
}

/** Result of `--continue` — mirror of the CLI's `ContinueMergeResult`. */
export interface ContinueMergeResult {
  name: string
  /** True when every conflict was resolved and the metadata was updated. */
  resolved: boolean
  remainingConflicts: MergeSkillConflict[]
  filesMerged: number
  changes: number
  baseRevision?: string
}

/** Result of `--abort` — mirror of the CLI's `AbortMergeResult`. */
export interface AbortMergeResult {
  name: string
  filesRestored: number
}

export interface MergeSkillOptions {
  repositoryRoot: string
  homeRoot?: string
  /** Binary handling (default `fail`: throw `MERGE_BINARY_CONFLICT`). */
  binary?: BinaryMergePolicy
  git?: GitClient
  registry?: ProviderRegistry
  remoteRoot?: string
  filesystem?: FilesystemService
}

interface MergeContext {
  homeRoot: string
  manifest: SkillboxManifest
  lockfile: SkillboxLockfile
  resolver: SkillContentResolver
  filesystem: FilesystemService
}

/**
 * M20.6 `mergeSkill()`: 3-way merge of a managed or forked skill against its
 * latest upstream revision, with conflict state persistence and pre-merge
 * backup.
 */
export async function mergeSkill(
  name: string,
  options: MergeSkillOptions,
): Promise<MergeSkillResult> {
  const ctx = await openContext(options)
  const skill = requireSkill(ctx.manifest, name)
  const mode = mergeableMode(skill)
  if (mode === null) {
    throw noBase(
      `Skill "${name}" is ${deriveMode(skill)} mode — only managed and forked skills can merge upstream changes`,
      { name, mode: deriveMode(skill) },
    )
  }
  const locked = ctx.lockfile.skills[name]
  if (locked === undefined) {
    throw noBase(`Skill "${name}" has no lockfile entry (base revision unknown)`, { name })
  }
  const upstream = locked.upstream
  if (upstream === undefined || upstream.baseRevision === '') {
    throw noBase(`Skill "${name}" records no upstream base revision in the lockfile`, { name })
  }
  if (await hasPendingMerge(ctx.homeRoot, name, ctx.filesystem)) {
    throw new SkillboxError(
      ErrorCode.MERGE_ALREADY_IN_PROGRESS,
      `A merge for "${name}" is already in progress — resolve the conflicts and run "skillbox merge --continue" or "skillbox merge --abort"`,
      { context: { name } },
    )
  }

  const localDir = await resolveLocalDir(ctx, name, skill, mode)
  const baseContent = await ctx.resolver.base(skill, locked)
  const upstreamContent = await ctx.resolver.upstream(skill, locked)
  try {
    /* M20.8 — pre-merge backup, before anything touches the content. */
    await createBackup({
      homeRoot: ctx.homeRoot,
      alias: name,
      localDir,
      filesystem: ctx.filesystem,
    })

    const [baseTree, localTree, upstreamTree] = await Promise.all([
      scanSkillTree(baseContent.dir),
      scanSkillTree(localDir),
      scanSkillTree(upstreamContent.dir),
    ])
    const merged = mergeTrees(baseTree, localTree, upstreamTree, {
      binary: options.binary ?? 'fail',
    })
    const conflictFiles = merged.conflicts.map((file) => ({
      path: file.path,
      hunks: file.hunks.length,
    }))
    const mergedRevision =
      upstreamContent.revision ?? upstream.latestRevision ?? upstream.baseRevision

    if (conflictFiles.length > 0) {
      // Snapshot the three views while local is still the pre-merge content.
      await saveMergeState({
        homeRoot: ctx.homeRoot,
        alias: name,
        mode,
        baseRevision: upstream.baseRevision,
        latestRevision: mergedRevision,
        conflictFiles,
        baseDir: baseContent.dir,
        localDir,
        upstreamDir: upstreamContent.dir,
        filesystem: ctx.filesystem,
      })
    }

    await writeSkillTree(localDir, merged.files, localTree, ctx.filesystem)

    if (conflictFiles.length > 0) {
      return {
        name,
        conflicts: conflictFiles,
        filesMerged: merged.changedCount,
        changes: merged.conflicts.reduce((sum, file) => sum + file.hunks.length, 0),
      }
    }

    await advanceLockfileMetadata({
      repositoryRoot: options.repositoryRoot,
      lockfile: ctx.lockfile,
      alias: name,
      locked,
      mode,
      mergedRevision,
      localDir,
      upstreamDir: upstreamContent.dir,
      filesystem: ctx.filesystem,
    })
    return {
      name,
      conflicts: [],
      filesMerged: merged.changedCount,
      changes: 0,
      baseRevision: mergedRevision,
    }
  } finally {
    await safeCleanup(baseContent)
    await safeCleanup(upstreamContent)
  }
}

/**
 * M20.6 `continueMerge()`: checks whether every conflict file is resolved
 * (no `<<<<<<<`/`>>>>>>>` marker lines left) and, when so, completes the
 * metadata update (M20.4) and clears the merge state.
 */
export async function continueMerge(
  name: string,
  options: MergeSkillOptions,
): Promise<ContinueMergeResult> {
  const ctx = await openContext(options)
  const state = await requireInProgressMerge(ctx, name)
  const skill = requireSkill(ctx.manifest, name)
  const mode = mergeableMode(skill)
  if (mode === null) {
    throw noBase(
      `Skill "${name}" is ${deriveMode(skill)} mode — only managed and forked skills can merge upstream changes`,
      { name, mode: deriveMode(skill) },
    )
  }
  const locked = ctx.lockfile.skills[name]
  if (locked === undefined) {
    throw noBase(`Skill "${name}" has no lockfile entry (base revision unknown)`, { name })
  }
  const localDir = await resolveLocalDir(ctx, name, skill, mode)
  const statePaths = mergeStatePaths(ctx.homeRoot, name)

  const remaining: MergeSkillConflict[] = []
  for (const entry of state.conflictFiles) {
    const filePath = resolveInsideRoot(localDir, entry.path)
    if (await ctx.filesystem.exists(filePath)) {
      if (containsConflictMarkers(await ctx.filesystem.readFile(filePath))) {
        remaining.push({ path: entry.path, hunks: entry.hunks })
      }
    } else {
      // Deleted by the user while resolving — treated as resolved.
    }
  }
  if (remaining.length > 0) {
    return { name, resolved: false, remainingConflicts: remaining, filesMerged: 0, changes: 0 }
  }

  await advanceLockfileMetadata({
    repositoryRoot: options.repositoryRoot,
    lockfile: ctx.lockfile,
    alias: name,
    locked,
    mode,
    mergedRevision: state.latestRevision,
    localDir,
    upstreamDir: statePaths.upstreamDir,
    filesystem: ctx.filesystem,
  })
  await removeMergeState(ctx.homeRoot, name, ctx.filesystem)
  return {
    name,
    resolved: true,
    remainingConflicts: [],
    filesMerged: state.conflictFiles.length,
    changes: state.conflictFiles.reduce((sum, entry) => sum + entry.hunks, 0),
    baseRevision: state.latestRevision,
  }
}

/**
 * M20.7 `abortMerge()`: restores the pre-merge local content from the state
 * snapshot and clears the merge state.
 */
export async function abortMerge(
  name: string,
  options: MergeSkillOptions,
): Promise<AbortMergeResult> {
  const ctx = await openContext(options)
  await requireInProgressMerge(ctx, name)
  const skill = requireSkill(ctx.manifest, name)
  const mode = mergeableMode(skill)
  if (mode === null) {
    throw noBase(
      `Skill "${name}" is ${deriveMode(skill)} mode — only managed and forked skills can merge upstream changes`,
      { name, mode: deriveMode(skill) },
    )
  }
  const localDir = await resolveLocalDir(ctx, name, skill, mode)
  const statePaths = mergeStatePaths(ctx.homeRoot, name)

  const filesRestored = await countFilesIn(statePaths.localDir)
  await ctx.filesystem.remove(localDir)
  await ctx.filesystem.copy(statePaths.localDir, localDir)
  await removeMergeState(ctx.homeRoot, name, ctx.filesystem)
  return { name, filesRestored }
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

async function openContext(options: MergeSkillOptions): Promise<MergeContext> {
  const homeRoot = options.homeRoot ?? resolveSkillboxHome()
  const resolver = new SkillContentResolver({
    repositoryRoot: options.repositoryRoot,
    homeRoot,
    git: options.git,
    registry: options.registry,
    remoteRoot: options.remoteRoot,
    filesystem: options.filesystem,
  })
  // Read sequentially so a failure cannot leave filesystem work running after
  // mergeSkill has rejected, which can race with cleanup on Windows.
  const manifest = await readManifest(options.repositoryRoot)
  const lockfile = await readLockfile(options.repositoryRoot)
  return {
    homeRoot,
    manifest,
    lockfile,
    resolver,
    filesystem: resolverFilesystem(options),
  }
}

function resolverFilesystem(options: MergeSkillOptions): FilesystemService {
  return options.filesystem ?? new FilesystemService()
}

function requireSkill(manifest: SkillboxManifest, name: string): ManifestSkill {
  const skill = manifest.skills[name]
  if (skill === undefined) {
    throw new SkillboxError(ErrorCode.SKILL_NOT_FOUND, `Skill "${name}" is not in the manifest`, {
      context: { name },
    })
  }
  return skill
}

function noBase(message: string, context: Record<string, unknown>): SkillboxError {
  return new SkillboxError(ErrorCode.MERGE_NO_BASE, message, { context })
}

/** The two mergeable modes, or null for local/vendored skills. */
function mergeableMode(skill: ManifestSkill): 'managed' | 'forked' | null {
  const mode = deriveMode(skill)
  return mode === 'managed' || mode === 'forked' ? mode : null
}

/**
 * Where the merge writes its result — the skill's own content directory:
 * the managed runtime in the library, or the repository path of a fork.
 */
async function resolveLocalDir(
  ctx: MergeContext,
  name: string,
  skill: ManifestSkill,
  mode: 'managed' | 'forked',
): Promise<string> {
  let dir: string
  if (mode === 'managed') {
    dir = new RuntimeLibraryService(path.join(ctx.homeRoot, 'library'), ctx.filesystem).pathFor(
      name,
      'managed',
    )
  } else {
    dir = ctx.resolver.localSourceDir(skill)
  }
  if (!(await ctx.filesystem.exists(dir))) {
    throw new SkillboxError(
      ErrorCode.SKILL_MISSING,
      `Skill "${name}" content not found at "${dir}"`,
      { context: { name, dir } },
    )
  }
  return dir
}

async function requireInProgressMerge(ctx: MergeContext, name: string): Promise<MergeStateRecord> {
  const state = await loadMergeState(ctx.homeRoot, name, ctx.filesystem)
  if (state === undefined) {
    throw new SkillboxError(ErrorCode.MERGE_NOT_IN_PROGRESS, `No merge in progress for "${name}"`, {
      context: { name },
    })
  }
  return state
}

/**
 * M20.4 metadata advance after a clean merge: the absorbed upstream revision
 * becomes the new base, integrity snapshots are refreshed, and managed skills
 * pin their `revision` to the merged upstream revision.
 */
async function advanceLockfileMetadata(input: {
  repositoryRoot: string
  lockfile: SkillboxLockfile
  alias: string
  locked: LockedSkill
  mode: 'managed' | 'forked'
  mergedRevision: string
  localDir: string
  upstreamDir: string
  filesystem: FilesystemService
}): Promise<void> {
  const upstreamBlock: LockedUpstream = {
    source: input.locked.upstream!.source,
    baseRevision: input.mergedRevision,
    baseIntegrity: await computeSkillIntegrity(input.upstreamDir),
    latestRevision: input.mergedRevision,
  }
  const nextLocked: LockedSkill = {
    ...input.locked,
    integrity: await computeSkillIntegrity(input.localDir),
    upstream: upstreamBlock,
  }
  if (input.mode === 'managed') {
    nextLocked.revision = input.mergedRevision
  }
  const nextLockfile: SkillboxLockfile = {
    ...input.lockfile,
    skills: { ...input.lockfile.skills, [input.alias]: nextLocked },
  }
  await writeLockfile(input.repositoryRoot, nextLockfile)
}

/**
 * Writes the merged tree into `localDir`: files that disappeared from the
 * merged tree are removed, every result file is written (parents created as
 * needed), and symlinks are recreated only when their on-disk target changed.
 */
async function writeSkillTree(
  localDir: string,
  files: TreeEntry[],
  previous: Map<string, TreeEntry>,
  filesystem: FilesystemService,
): Promise<void> {
  const resultPaths = new Set(files.map((entry) => entry.path))
  for (const oldPath of previous.keys()) {
    if (!resultPaths.has(oldPath)) {
      await filesystem.remove(resolveInsideRoot(localDir, oldPath))
    }
  }
  for (const entry of files) {
    const target = resolveInsideRoot(localDir, entry.path)
    await filesystem.mkdir(path.dirname(target))
    if (entry.kind === 'symlink') {
      let existing: Stats | undefined
      try {
        existing = await filesystem.lstat(target)
      } catch {
        // Absent — recreate below.
      }
      if (existing?.isSymbolicLink() && (await fs.readlink(target)) === entry.symlinkTarget) {
        continue
      }
      if (existing !== undefined) {
        await filesystem.remove(target)
      }
      await fs.symlink(entry.symlinkTarget ?? '', target)
    } else {
      await filesystem.writeFile(target, entry.bytes)
    }
  }
}

async function safeCleanup(content: { cleanup?: () => Promise<void> }): Promise<void> {
  if (content.cleanup !== undefined) {
    await content.cleanup()
  }
}
