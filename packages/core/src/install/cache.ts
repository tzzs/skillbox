import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { SkillboxError, ErrorCode } from '../errors.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import type { NormalizedSource } from '../registry/types.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'

/** Marker file inside a cache entry holding the entry integrity (`sha256:<hex>`). */
export const CACHE_INTEGRITY_MARKER = '.integrity'

export interface CacheEntry {
  /** Absolute path of the cached skill directory. */
  path: string
  /** Integrity recorded when the entry was written. */
  integrity: string
}

/** Canonical textual form of a source, used for the cache key. */
export function canonicalSourceString(source: NormalizedSource): string {
  switch (source.type) {
    case 'github': {
      let canonical = `github:${source.repo}`
      if (source.path !== undefined) canonical += `@${source.path}`
      if (source.ref !== undefined) canonical += `#${source.ref}`
      else if (source.branch !== undefined) canonical += `#${source.branch}`
      return canonical
    }
    case 'skills-sh': {
      let canonical = `skills-sh:${source.package}`
      if (source.version !== undefined) canonical += `@${source.version}`
      return canonical
    }
    case 'git': {
      let canonical = `git:${source.url}`
      if (source.path !== undefined) canonical += `@${source.path}`
      if (source.ref !== undefined) canonical += `#${source.ref}`
      return canonical
    }
    case 'local':
      return `local:${source.path}`
  }
}

/**
 * Cache directory key for a source: the first 16 hex chars of the SHA-256 of
 * the canonical source string (stable across platforms and alias changes).
 */
export function cacheSourceKey(source: NormalizedSource): string {
  return createHash('sha256').update(canonicalSourceString(source)).digest('hex').slice(0, 16)
}

function assertSafeRevision(revision: string): void {
  if (revision === '' || revision.includes('/') || revision.includes('\\')) {
    throw new SkillboxError(ErrorCode.CACHE_INVALID, `Unsafe cache revision "${revision}"`, {
      context: { revision },
    })
  }
}

/**
 * M15.3 Managed Cache over `~/.skillbox/cache/`.
 *
 * Layout: `cache/<source-key>/<revision>/` — the source key is derived from
 * the canonical source expression, the revision is the pinned commit/version.
 * The entry directory holds the *pure* skill content (so a cached copy can be
 * hashed or materialized like any fresh download); the integrity marker lives
 * in a sibling file `cache/<source-key>/<revision>.integrity`. A hit is only
 * trusted when the recorded integrity matches the expected one; entries
 * without a valid marker are treated as corrupt (`CACHE_INVALID`). The cache
 * is disposable by design: it can be deleted at any time (`clear()` /
 * `clearCache()`).
 */
export class ManagedCache {
  private readonly filesystem: FilesystemService

  constructor(
    readonly cacheRoot: string,
    filesystem?: FilesystemService,
  ) {
    this.filesystem = filesystem ?? new FilesystemService()
  }

  /** `cache/<source-key>/<revision>` for a source/revision pair. */
  entryDir(source: NormalizedSource, revision: string): string {
    assertSafeRevision(revision)
    return path.join(this.cacheRoot, cacheSourceKey(source), revision)
  }

  /** Sibling marker file of an entry dir (kept outside the content). */
  private markerPathFor(dir: string): string {
    return `${dir}${CACHE_INTEGRITY_MARKER}`
  }

  /**
   * Returns the cached entry when it exists and its integrity marker is
   * valid. `null` on a miss (never an error — downloading is the normal
   * path). Throws `CACHE_INVALID` when the entry exists but is corrupt
   * (missing/empty marker, or a marker that does not match
   * `expectedIntegrity` when one is given).
   */
  async get(
    source: NormalizedSource,
    revision: string,
    expectedIntegrity?: string,
  ): Promise<CacheEntry | null> {
    const dir = this.entryDir(source, revision)
    if (!(await this.filesystem.exists(dir))) {
      return null
    }
    const markerPath = this.markerPathFor(dir)
    if (!(await this.filesystem.exists(markerPath))) {
      throw this.invalidEntryError(dir, 'missing integrity marker')
    }
    const integrity = (await this.filesystem.readFile(markerPath)).trim()
    if (integrity === '') {
      throw this.invalidEntryError(dir, 'empty integrity marker')
    }
    if (expectedIntegrity !== undefined && integrity !== expectedIntegrity) {
      throw this.invalidEntryError(dir, `integrity ${integrity} != expected ${expectedIntegrity}`)
    }
    return { path: dir, integrity }
  }

  /** Strict variant: throws `CACHE_MISS` instead of returning `null`. */
  async requireEntry(
    source: NormalizedSource,
    revision: string,
    expectedIntegrity?: string,
  ): Promise<CacheEntry> {
    const entry = await this.get(source, revision, expectedIntegrity)
    if (entry === null) {
      throw new SkillboxError(
        ErrorCode.CACHE_MISS,
        `No cache entry for ${canonicalSourceString(source)} at revision ${revision}`,
        {
          context: { source, revision },
        },
      )
    }
    return entry
  }

  /**
   * Removes one entry. Used to purge corrupt entries so the next install
   * redownloads instead of failing on a stale marker.
   */
  async invalidate(source: NormalizedSource, revision: string): Promise<void> {
    await this.filesystem.remove(this.entryDir(source, revision))
  }

  /**
   * Writes `sourceDir` into the cache as `<revision>` with a sibling
   * integrity marker. The copy is staged under a `.partial-*` sibling first
   * and moved into place, so a crash never leaves a marker-less half entry.
   */
  async put(
    source: NormalizedSource,
    revision: string,
    integrity: string,
    sourceDir: string,
  ): Promise<CacheEntry> {
    const dir = this.entryDir(source, revision)
    const partial = `${dir}.partial-${process.pid}`
    await this.filesystem.remove(partial)
    await this.filesystem.mkdir(path.dirname(dir))
    await this.filesystem.copy(sourceDir, partial)
    await this.filesystem.remove(dir)
    await this.filesystem.move(partial, dir)
    await this.filesystem.writeFile(this.markerPathFor(dir), `${integrity}\n`)
    return { path: dir, integrity }
  }

  /** Removes the entire cache. The cache is disposable by design (M15.3). */
  async clear(): Promise<void> {
    await this.filesystem.remove(this.cacheRoot)
  }

  private invalidEntryError(dir: string, detail: string): SkillboxError {
    return new SkillboxError(
      ErrorCode.CACHE_INVALID,
      `Cache entry "${dir}" is invalid: ${detail}`,
      { context: { cacheRoot: this.cacheRoot, entry: dir } },
    )
  }
}

/**
 * M15.3 convenience: clears the managed cache under the Skillbox home
 * (default `~/.skillbox/cache/`, overridable via `SKILLBOX_HOME`). Safe to
 * call at any time — the cache is fully disposable.
 */
export async function clearCache(homeRoot?: string): Promise<void> {
  const layout = buildSkillboxHomeLayout(homeRoot ?? resolveSkillboxHome())
  await new ManagedCache(layout.cache).clear()
}
