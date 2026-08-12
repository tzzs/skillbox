/**
 * Content resolution shared by the Diff (M19) and Merge (M20) engines:
 * locating the local/current, base-snapshot and latest-upstream content of a
 * skill, and scanning a skill directory into a path → entry map.
 *
 * Resolution strategy per source type:
 * - `local` sources: the repository-relative path from the manifest.
 * - `git` sources: a temporary clone checked out at the exact revision
 *   (never the shared mirror — checking out an arbitrary SHA in the mirror
 *   would detach it and break Reconcile).
 * - `github` / `registry` sources: the registered `RegistryProvider`
 *   (`download` at a pinned revision into a temporary directory).
 * - "Latest upstream" for `git` sources: the shared mirror materialized at
 *   the pinned ref (clone-or-pull), matching Reconcile's model.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { scanSkillDirectory } from '../fs/scanner.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import type { ManifestSkill, ManifestSkillSource } from '../manifest/schema.js'
import type { LockedSkill } from '../lockfile/schema.js'
import { deriveMode } from '../manifest/schema.js'
import { GitClient, planRemoteSource, type GitMaterializeOptions } from '../git/index.js'
import {
  ProviderRegistry,
  fromManifestSource,
  type NormalizedSource,
  type RegistryProvider,
} from '../registry/index.js'
import { isBinaryContent as looksBinary } from './binary.js'
import type { CanonicalSkillSource, SkillSourceResolver } from '../sources/index.js'

/** A resolved content directory plus optional cleanup of temporary storage. */
export interface ResolvedContent {
  /** Absolute directory holding the skill content. */
  dir: string
  /** Revision the content is pinned at, when known. */
  revision?: string
  /** Removes temporary storage (no-op for persistent/mirror directories). */
  cleanup?: () => Promise<void>
}

export interface ContentResolverOptions {
  repositoryRoot: string
  homeRoot: string
  git?: GitClient | undefined
  registry?: ProviderRegistry | undefined
  remoteRoot?: string | undefined
  filesystem?: FilesystemService | undefined
  /**
   * Canonical source boundary for remote content. When present, diff/merge
   * resolve pinned and latest revisions through its adapters rather than the
   * legacy registry and git clients.
   */
  sourceResolver?: SkillSourceResolver | undefined
}

/**
 * Resolves the three content views a skill diff/merge operates on. Instances
 * are cheap and stateless; create one per operation.
 */
export class SkillContentResolver {
  private readonly filesystem: FilesystemService
  private readonly git: GitClient
  private readonly registry: ProviderRegistry
  private readonly remoteRoot: string
  private readonly tmpRoot: string
  private readonly sourceResolver: SkillSourceResolver | undefined

  constructor(private readonly options: ContentResolverOptions) {
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.git = options.git ?? new GitClient()
    this.registry = options.registry ?? new ProviderRegistry()
    this.remoteRoot = options.remoteRoot ?? path.join(options.homeRoot, 'cache', 'git')
    this.tmpRoot = path.join(options.homeRoot, 'tmp')
    this.sourceResolver = options.sourceResolver
  }

  /** Absolute directory holding the manifest's local content for `skill`. */
  localSourceDir(skill: ManifestSkill): string {
    if (skill.source.type !== 'local') {
      throw new SkillboxError(
        ErrorCode.DIFF_BASE_UNAVAILABLE,
        `Skill source "${skill.source.type}" has no repository-local directory`,
        { context: { source: skill.source } },
      )
    }
    return resolveInsideRoot(this.options.repositoryRoot, skill.source.path)
  }

  /**
   * Current/local content of a skill: the repo path for local sources, the
   * locked-revision download for remote sources, or the mirror when no
   * revision is locked yet.
   */
  async current(skill: ManifestSkill, locked: LockedSkill | undefined): Promise<ResolvedContent> {
    if (skill.source.type === 'local') {
      return { dir: this.localSourceDir(skill) }
    }
    const revision = locked?.revision
    if (revision !== undefined) {
      return this.atRevision(skill.source, revision)
    }
    if (this.sourceResolver !== undefined) {
      const source = this.canonical(skill.source)
      const adapter = this.sourceResolver.adapterFor(source, 'resolve')
      if (adapter.resolve === undefined) {
        throw new SkillboxError(
          ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
          `Source type "${source.type}" cannot resolve a current revision`,
          { context: { source } },
        )
      }
      const resolved = await adapter.resolve(source)
      return this.atCanonicalRevision(resolved.source, resolved.revision)
    }
    if (skill.source.type === 'git') {
      return this.gitMirror(skill.source)
    }
    const provider = this.providerFor(skill.source)
    const source = this.normalized(skill.source)
    const resolved = await provider.resolve(source)
    return this.downloadToTemp(provider, source, resolved.revision)
  }

  /**
   * Content of the upstream base snapshot (the fork's baseRevision, recorded
   * in the lockfile's `upstream.baseRevision`).
   */
  async base(skill: ManifestSkill, locked: LockedSkill | undefined): Promise<ResolvedContent> {
    const source = this.upstreamSource(skill)
    const baseRevision = locked?.upstream?.baseRevision
    if (baseRevision === undefined) {
      throw new SkillboxError(
        ErrorCode.DIFF_BASE_UNAVAILABLE,
        'No upstream base snapshot recorded (lockfile upstream.baseRevision is missing)',
        { context: { source } },
      )
    }
    return this.atRevision(source, baseRevision)
  }

  /**
   * Content of the latest upstream revision. Prefers a live provider lookup;
   * falls back to the lockfile's recorded `upstream.latestRevision`.
   */
  async upstream(skill: ManifestSkill, locked: LockedSkill | undefined): Promise<ResolvedContent> {
    const source = this.upstreamSource(skill)
    if (this.sourceResolver !== undefined) {
      const canonical = this.canonical(source)
      const adapter = this.sourceResolver.adapterFor(canonical, 'latest')
      if (adapter.latest === undefined) {
        throw new SkillboxError(
          ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
          `Source type "${canonical.type}" cannot determine its latest revision`,
          { context: { source: canonical } },
        )
      }
      return this.atCanonicalRevision(canonical, await adapter.latest(canonical))
    }
    if (source.type === 'git') {
      return this.gitMirror(source)
    }
    const provider = this.providerFor(source)
    const normalized = this.normalized(source)
    let revision: string
    try {
      revision = await provider.getLatestRevision(normalized)
    } catch (error) {
      const recorded = locked?.upstream?.latestRevision
      if (recorded === undefined) {
        throw new SkillboxError(
          ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
          `Latest upstream revision unavailable: ${describe(error)}`,
          { cause: error, context: { source } },
        )
      }
      revision = recorded
    }
    return this.downloadToTemp(provider, normalized, revision)
  }

  /**
   * The upstream source a skill tracks (`upstream` for forks, `source`
   * otherwise).
   */
  upstreamSource(skill: ManifestSkill): ManifestSkillSource {
    const mode = deriveMode(skill)
    if (mode === 'forked') {
      if (skill.upstream === undefined) {
        throw new SkillboxError(
          ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
          'Forked skill declares no upstream source',
          { context: { skill } },
        )
      }
      return skill.upstream
    }
    return skill.source
  }

  /** Content at an exact revision: temp clone for git, provider download otherwise. */
  private async atRevision(
    source: ManifestSkillSource,
    revision: string,
  ): Promise<ResolvedContent> {
    if (this.sourceResolver !== undefined && source.type !== 'local') {
      return this.atCanonicalRevision(this.canonical(source), revision)
    }
    if (source.type === 'git') {
      const dir = await this.tempDir('skillbox-git-')
      try {
        await this.git.materialize({ url: source.url, targetDir: dir })
        await this.git.checkout(dir, revision)
      } catch (error) {
        await this.filesystem.remove(dir)
        throw error
      }
      const resolved: ResolvedContent = { dir, revision }
      if (source.path !== undefined) {
        resolved.dir = resolveInsideRoot(dir, source.path)
      }
      resolved.cleanup = () => this.filesystem.remove(dir)
      return resolved
    }
    if (source.type === 'local') {
      return { dir: path.resolve(source.path), revision }
    }
    const provider = this.providerFor(source)
    return this.downloadToTemp(provider, this.normalized(source), revision)
  }

  private async atCanonicalRevision(
    source: CanonicalSkillSource,
    revision: string,
  ): Promise<ResolvedContent> {
    if (source.type === 'local') {
      return { dir: path.resolve(source.path), revision }
    }
    const adapter = this.sourceResolver?.adapterFor(source, 'materialize')
    if (adapter?.materialize === undefined) {
      throw new SkillboxError(
        ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
        `Source type "${source.type}" cannot materialize revision "${revision}"`,
        { context: { source, revision } },
      )
    }
    const dir = await this.tempDir('skillbox-source-')
    try {
      await adapter.materialize(source, revision, dir)
      const sourcePath = 'path' in source ? source.path : undefined
      const contentDir = sourcePath === undefined ? dir : resolveInsideRoot(dir, sourcePath)
      return { dir: contentDir, revision, cleanup: () => this.filesystem.remove(dir) }
    } catch (error) {
      await this.filesystem.remove(dir)
      throw error
    }
  }

  private canonical(source: ManifestSkillSource): CanonicalSkillSource {
    if (this.sourceResolver === undefined) {
      throw new Error('canonical source resolver is unavailable')
    }
    return this.sourceResolver.fromManifest(source)
  }

  /**
   * The shared git mirror for a git source, materialized at its pinned ref
   * (clone-or-pull). The mirror is persistent — no cleanup.
   */
  private async gitMirror(source: ManifestSkillSource): Promise<ResolvedContent> {
    if (source.type !== 'git') {
      throw new SkillboxError(
        ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
        `Source type "${source.type}" is not git-based`,
        {
          context: { source },
        },
      )
    }
    const plan = planRemoteSource(source)
    if (plan === undefined) {
      throw new SkillboxError(
        ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
        `No materialization plan for git source "${source.url}"`,
        { context: { source } },
      )
    }
    const targetDir = path.join(this.remoteRoot, plan.key)
    const materializeOptions: GitMaterializeOptions = { url: plan.url, targetDir }
    if (plan.ref !== undefined) {
      materializeOptions.ref = plan.ref
    }
    await this.git.materialize(materializeOptions)
    const headRev = await this.git.revParse(targetDir, 'HEAD')
    let dir = targetDir
    if (source.path !== undefined) {
      dir = resolveInsideRoot(targetDir, source.path)
    }
    return { dir, revision: headRev }
  }

  private async downloadToTemp(
    provider: RegistryProvider,
    source: NormalizedSource,
    revision: string,
  ): Promise<ResolvedContent> {
    const dir = await this.tempDir('skillbox-dl-')
    try {
      await provider.download(source, revision, dir)
    } catch (error) {
      await this.filesystem.remove(dir)
      throw error
    }
    return { dir, revision, cleanup: () => this.filesystem.remove(dir) }
  }

  private async tempDir(prefix: string): Promise<string> {
    await this.filesystem.mkdir(this.tmpRoot)
    return mkdtemp(path.join(this.tmpRoot, prefix))
  }

  private providerFor(source: ManifestSkillSource): RegistryProvider {
    const providerId =
      source.type === 'github' ? 'github' : source.type === 'registry' ? 'skills-sh' : source.type
    try {
      return this.registry.resolveProvider(providerId)
    } catch (error) {
      throw new SkillboxError(
        ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
        `No registry provider registered for source type "${source.type}"`,
        { cause: error, context: { source } },
      )
    }
  }

  private normalized(source: ManifestSkillSource): NormalizedSource {
    const normalized = fromManifestSource(source)
    if (normalized === null) {
      throw new SkillboxError(
        ErrorCode.DIFF_UPSTREAM_UNAVAILABLE,
        `Source type "${source.type}" has no registry representation`,
        { context: { source } },
      )
    }
    return normalized
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 * Skill tree scanning
 * ------------------------------------------------------------------ */

/** One node of a scanned skill tree. */
export interface TreeEntry {
  /** Portable relative path (forward slashes on every platform). */
  path: string
  kind: 'file' | 'symlink'
  /** Raw file bytes (symlink entries carry the link target as UTF-8). */
  bytes: Buffer
  /** Symlink target for `symlink` entries. */
  symlinkTarget?: string
}

/** VCS/state directories that never participate in a skill tree. */
const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.skillbox', '.svn', '.hg'])

function isIgnoredPath(relativePath: string): boolean {
  for (const segment of relativePath.split('/')) {
    if (IGNORED_DIRECTORY_NAMES.has(segment)) {
      return true
    }
  }
  return false
}

/** Scans a skill directory into a `relative path → entry` map. */
export async function scanSkillTree(dir: string): Promise<Map<string, TreeEntry>> {
  const scan = await scanSkillDirectory(dir)
  const entries = new Map<string, TreeEntry>()
  for (const filePath of scan.files) {
    if (isIgnoredPath(filePath)) {
      continue
    }
    const bytes = await fs.readFile(path.join(scan.root, filePath))
    entries.set(filePath, { path: filePath, kind: 'file', bytes })
  }
  for (const node of scan.symlinks) {
    if (isIgnoredPath(node.relativePath)) {
      continue
    }
    const bytes = Buffer.from(node.symlinkTarget ?? '', 'utf8')
    const entry: TreeEntry = { path: node.relativePath, kind: 'symlink', bytes }
    if (node.symlinkTarget !== undefined) {
      entry.symlinkTarget = node.symlinkTarget
    }
    entries.set(node.relativePath, entry)
  }
  return entries
}

export { looksBinary as isBinaryContent }

/** Decodes tree entry bytes as text (lossy for binary content). */
export function entryText(entry: TreeEntry): string {
  return entry.bytes.toString('utf8')
}

/** Equal-by-bytes comparison of two tree entries. */
export function entriesEqual(left: TreeEntry, right: TreeEntry): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  return left.bytes.equals(right.bytes)
}
