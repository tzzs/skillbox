import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { ManifestSkillSource } from '../manifest/schema.js'

/** Relative path (under the Skillbox home) where remote clones are cached. */
export const REMOTE_CLONE_RELATIVE_ROOT = path.join('cache', 'git')

/** A git source can be cloned/pulled with the system git binary today. */
export interface RemoteSourcePlan {
  /** Clone URL handed to `git clone`/`git pull` (no token embedded). */
  url: string
  /** Branch/tag to check out, when the source pins one. */
  ref?: string
  /** Deterministic directory name derived from the URL (url-key). */
  key: string
}

/**
 * Resolves the local mirror root for remote git sources given the runtime
 * library root. Defaults to `~/.skillbox/cache/git` when the library lives
 * directly under the skillbox home.
 */
export function remoteMaterializeRoot(libraryRoot: string): string {
  return path.join(path.dirname(libraryRoot), REMOTE_CLONE_RELATIVE_ROOT)
}

/** Stable short key for a clone URL, safe to use as a directory name. */
export function remoteCacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

/**
 * Maps a manifest source to what the system git binary can reach.
 *
 * - `git` sources: used verbatim (`url`/`ref`).
 * - `github` sources: the public HTTPS clone URL is derived from `repo` so
 *   public repositories work without a GitHub connection. Private
 *   repositories need the GitHub app credential bridge (agent 2); when the
 *   machine has a git credential helper configured, `git clone` picks it up
 *   automatically for the same URL.
 * - `registry`/`local`: not clone-able via git today.
 */
export function planRemoteSource(source: ManifestSkillSource): RemoteSourcePlan | undefined {
  if (source.type === 'git') {
    return {
      url: source.url,
      ...(source.ref !== undefined ? { ref: source.ref } : {}),
      key: remoteCacheKey(source.url),
    }
  }
  if (source.type === 'github') {
    const url = githubCloneUrl(source.repo)
    return {
      url,
      ...(source.ref !== undefined ? { ref: source.ref } : {}),
      key: remoteCacheKey(url),
    }
  }
  return undefined
}

/**
 * Builds a clone URL for a `github` source. Accepts `org/repo`,
 * `org/repo.git`, a full `https://...` or scp-style URL.
 */
export function githubCloneUrl(repo: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(repo) || repo.startsWith('git@')) {
    return repo
  }
  return `https://github.com/${repo.replace(/\.git$/, '')}.git`
}
