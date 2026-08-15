/** Registry source types the framework can normalize and dispatch on. */
export type RegistrySourceType = 'github' | 'skills-sh' | 'git' | 'local'

export const REGISTRY_SOURCE_TYPES: readonly RegistrySourceType[] = [
  'github',
  'skills-sh',
  'git',
  'local',
]

/** Where the skill lives inside a GitHub repository. */
export interface GithubNormalizedSource {
  type: 'github'
  /** GitHub repository in `owner/repo` form. */
  repo: string
  /** Repo-relative skill directory, e.g. `skills/react-best-practices`. */
  path?: string
  /** Resolved branch name (`main`) when the user pinned one. */
  branch?: string
  /** Raw branch/tag/commit the user pinned, e.g. `main` or `v1.0.0`. */
  ref?: string
}

/** A skills.sh registry package. */
export interface SkillsShNormalizedSource {
  type: 'skills-sh'
  /** Registry package expression, e.g. `owner/repo@skills/<name>`. */
  package: string
  /** Underlying GitHub repository when the package maps to one. */
  repo?: string
  /** Repo-relative skill directory, when known. */
  path?: string
  /** Version pin when a registry response provides one. */
  version?: string
}

/** A skill rooted at a local directory. */
export interface LocalNormalizedSource {
  type: 'local'
  /** Absolute, resolved directory path. */
  path: string
}

/**
 * A generic git repository source (`git:` URLs and scp-style `git@host:path`
 * expressions, i.e. any host). GitHub is handled by {@link GithubNormalizedSource};
 * GitLab / Bitbucket / self-hosted remotes land here.
 */
export interface GitNormalizedSource {
  type: 'git'
  /** Clone URL (https / ssh / scp-style). */
  url: string
  /** Repo-relative skill directory inside the checkout. */
  path?: string
  /** Branch / tag / commit pin. */
  ref?: string
}

/**
 * Canonical form of a skill source (SPEC §23). Every registry-aware consumer
 * (search/add/outdated/update, install transaction, web) works against this
 * shape; the lockfile records it verbatim.
 */
export type NormalizedSource =
  GithubNormalizedSource | SkillsShNormalizedSource | GitNormalizedSource | LocalNormalizedSource

/** Security review state reported by a registry (or unknown). */
export type SecurityReviewState = 'unknown' | 'reviewed'

export interface RegistrySearchResult {
  /** Display name of the skill. */
  name: string
  /** Canonical source expression (e.g. `github:org/repo@path`). */
  source: string
  /** Downloads / star count; `0` when the registry does not report one. */
  popularity: number
  /** `'reviewed'` when the registry vouches for the skill, else `'unknown'`. */
  security: SecurityReviewState
  /** Registry description; empty when missing. */
  description: string
}

export interface ResolvedSource {
  /** The same normalized source that was resolved. */
  source: NormalizedSource
  /** Pinned revision (commit SHA for git-backed sources). */
  revision: string
  /** Canonical integrity hash when computable at resolve time. */
  integrity?: string
}

/**
 * A registry provider handles one source type end to end: discovery, pinning
 * a branch/tag to a revision, materializing the skill subtree, and answering
 * "what is the latest revision now".
 */
export interface RegistryProvider {
  /** Provider id: `github` | `skills-sh` | `local`. */
  id: string
  search(query: string): Promise<RegistrySearchResult[]>
  /** Pins branch/tag to a concrete revision, returning integrity when cheap. */
  resolve(source: NormalizedSource): Promise<ResolvedSource>
  /** Materializes the skill subtree of `source` at `revision` into `targetDir`. */
  download(source: NormalizedSource, revision: string, targetDir: string): Promise<void>
  /** Latest revision for `source` (e.g. default-branch commit SHA). */
  getLatestRevision(source: NormalizedSource): Promise<string>
}

export type { ManifestSkillSource } from '../manifest/schema.js'
