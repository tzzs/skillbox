/**
 * M19.2 / M19.3 Skill Diff — `diffSkill(alias, options)`.
 *
 * Managed skills compare the current content against the latest upstream
 * revision; forked skills expose three views (Base / Local / Upstream). The
 * result shape matches the CLI contract (`packages/cli/src/skill-lifecycle/
 * types.ts` `SkillDiff`) so `skillbox diff` renders it directly.
 */
import type { ManifestSkill, SkillboxManifest } from '../manifest/schema.js'
import { deriveMode } from '../manifest/schema.js'
import type { LockedSkill, SkillboxLockfile } from '../lockfile/schema.js'
import { readManifest } from '../manifest/index.js'
import { readLockfile } from '../lockfile/index.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import type { SkillMode } from '../domain/skill.js'
import { diffTexts, renderUnifiedBody, type DiffLine } from './text.js'
import {
  SkillContentResolver,
  entryText,
  entriesEqual,
  isBinaryContent,
  scanSkillTree,
  type ResolvedContent,
  type TreeEntry,
} from './sources.js'
import type { GitClient } from '../git/index.js'
import type { ProviderRegistry } from '../registry/index.js'
import type { FilesystemService } from '../fs/filesystem-service.js'
import { resolveSkillboxHome } from '../runtime/paths.js'

export type SkillDiffWhich = 'managed' | 'base-local' | 'local-upstream' | 'base-upstream'

/** One changed file of a diff view. */
export interface SkillFileDiff {
  /** Portable relative path (forward slashes). */
  path: string
  status: 'added' | 'modified' | 'deleted'
  /** Unified-diff body for this file (empty for binary files). */
  patch: string
  /** True for binary files, whose contents are never rendered. */
  binary?: boolean
}

/** One comparison of a skill. */
export interface SkillDiffView {
  /** Display label rendered as a section header (e.g. `Base vs Local`). */
  label: string
  /** Only files that changed appear here. */
  files: SkillFileDiff[]
}

/** Result of `diffSkill` — mirror of the CLI's `SkillDiff` contract. */
export interface SkillDiff {
  name: string
  mode: SkillMode
  views: SkillDiffView[]
  /** True when every view has no changes — the "No changes" case. */
  unchanged: boolean
}

export interface DiffSkillOptions {
  repositoryRoot: string
  homeRoot?: string
  /**
   * Narrow the diff to a single comparison. Default: `managed` for managed
   * skills, all three fork views for forked skills.
   */
  which?: SkillDiffWhich
  git?: GitClient
  registry?: ProviderRegistry
  remoteRoot?: string
  filesystem?: FilesystemService
}

interface DiffContext {
  manifest: SkillboxManifest
  lockfile: SkillboxLockfile
  resolver: SkillContentResolver
}

/**
 * M19.2/19.3 `diffSkill()`: file-level + line-level diff of a skill against
 * its upstream. Reads only — never writes to the repository.
 */
export async function diffSkill(name: string, options: DiffSkillOptions): Promise<SkillDiff> {
  const ctx = await openContext(options)
  const skill = ctx.manifest.skills[name]
  if (skill === undefined) {
    throw new SkillboxError(ErrorCode.SKILL_NOT_FOUND, `Skill "${name}" is not in the manifest`, {
      context: { name },
    })
  }
  const mode = deriveMode(skill)
  if (mode !== 'managed' && mode !== 'forked') {
    throw new SkillboxError(
      ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
      `Skill "${name}" (${mode} mode) has no upstream to diff against`,
      { context: { name, mode } },
    )
  }
  const locked = ctx.lockfile.skills[name]

  let views: SkillDiffView[] = []
  if (mode === 'forked' && options.which !== undefined) {
    const spec = viewSpec(options.which)
    views = [await buildView(ctx, skill, locked, options.which, spec.label)]
  } else if (mode === 'forked') {
    views = [
      await buildView(ctx, skill, locked, 'base-local', 'Base vs Local'),
      await buildView(ctx, skill, locked, 'local-upstream', 'Local vs Latest'),
      await buildView(ctx, skill, locked, 'base-upstream', 'Base vs Latest'),
    ]
  } else {
    views = [await buildView(ctx, skill, locked, 'managed', 'Current vs Latest')]
  }

  const unchanged = views.every((view) => view.files.length === 0)
  return { name, mode, views, unchanged }
}

function viewSpec(which: SkillDiffWhich): { label: string } {
  switch (which) {
    case 'managed':
      return { label: 'Current vs Latest' }
    case 'base-local':
      return { label: 'Base vs Local' }
    case 'local-upstream':
      return { label: 'Local vs Latest' }
    case 'base-upstream':
      return { label: 'Base vs Latest' }
  }
}

async function openContext(options: DiffSkillOptions): Promise<DiffContext> {
  const homeRoot = options.homeRoot ?? resolveSkillboxHome()
  const resolver = new SkillContentResolver({
    repositoryRoot: options.repositoryRoot,
    homeRoot,
    git: options.git,
    registry: options.registry,
    remoteRoot: options.remoteRoot,
    filesystem: options.filesystem,
  })
  const [manifest, lockfile] = await Promise.all([
    readManifest(options.repositoryRoot),
    readLockfile(options.repositoryRoot),
  ])
  return { manifest, lockfile, resolver }
}

async function buildView(
  ctx: DiffContext,
  skill: ManifestSkill,
  locked: LockedSkill | undefined,
  which: SkillDiffWhich,
  label: string,
): Promise<SkillDiffView> {
  const [left, right] = await resolveViewPair(ctx, skill, locked, which)
  try {
    const files = await compareSkillTrees(left.dir, right.dir)
    return { label, files }
  } finally {
    await cleanupContent(left)
    await cleanupContent(right)
  }
}

async function cleanupContent(content: ResolvedContent): Promise<void> {
  if (content.cleanup !== undefined) {
    await content.cleanup()
  }
}

async function resolveViewPair(
  ctx: DiffContext,
  skill: ManifestSkill,
  locked: LockedSkill | undefined,
  which: SkillDiffWhich,
): Promise<[ResolvedContent, ResolvedContent]> {
  switch (which) {
    case 'managed':
      return [await ctx.resolver.current(skill, locked), await ctx.resolver.upstream(skill, locked)]
    case 'base-local':
      return [await ctx.resolver.base(skill, locked), await ctx.resolver.current(skill, locked)]
    case 'local-upstream':
      return [await ctx.resolver.current(skill, locked), await ctx.resolver.upstream(skill, locked)]
    case 'base-upstream':
      return [await ctx.resolver.base(skill, locked), await ctx.resolver.upstream(skill, locked)]
  }
}

/** File-level comparison of two skill trees; only changed files are returned. */
export async function compareSkillTrees(
  leftDir: string,
  rightDir: string,
): Promise<SkillFileDiff[]> {
  const [left, right] = await Promise.all([scanSkillTree(leftDir), scanSkillTree(rightDir)])
  return compareTreeMaps(left, right)
}

/** Pure comparison of two tree maps (used by `compareSkillTrees` and tests). */
export function compareTreeMaps(
  left: Map<string, TreeEntry>,
  right: Map<string, TreeEntry>,
): SkillFileDiff[] {
  const paths = new Set<string>([...left.keys(), ...right.keys()])
  const files: SkillFileDiff[] = []
  for (const filePath of [...paths].sort()) {
    const leftEntry = left.get(filePath)
    const rightEntry = right.get(filePath)
    if (leftEntry !== undefined && rightEntry === undefined) {
      if (isBinaryContent(leftEntry.bytes)) {
        files.push({ path: filePath, status: 'deleted', patch: '', binary: true })
      } else {
        files.push({
          path: filePath,
          status: 'deleted',
          patch: unifiedBodyFor(entryText(leftEntry), ''),
        })
      }
    } else if (leftEntry === undefined && rightEntry !== undefined) {
      if (isBinaryContent(rightEntry.bytes)) {
        files.push({ path: filePath, status: 'added', patch: '', binary: true })
      } else {
        files.push({
          path: filePath,
          status: 'added',
          patch: unifiedBodyFor('', entryText(rightEntry)),
        })
      }
    } else if (leftEntry !== undefined && rightEntry !== undefined) {
      if (entriesEqual(leftEntry, rightEntry)) {
        continue
      }
      if (isBinaryContent(leftEntry.bytes) || isBinaryContent(rightEntry.bytes)) {
        files.push({ path: filePath, status: 'modified', patch: '', binary: true })
      } else {
        files.push({
          path: filePath,
          status: 'modified',
          patch: unifiedBodyFor(entryText(leftEntry), entryText(rightEntry)),
        })
      }
    }
  }
  return files
}

function unifiedBodyFor(baseText: string, targetText: string): string {
  const diff: DiffLine[] = diffTexts(baseText, targetText)
  return renderUnifiedBody(diff)
}
