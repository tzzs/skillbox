import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { GitClient } from '../git/index.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { RegistryError, RegistryErrorCode, toRegistryError } from './errors.js'
import type {
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
} from './types.js'

export interface GitSourceProviderOptions {
  /** Git wrapper; defaults to the system git binary. */
  git?: GitClient
  /** Temp root for the clone-or-checkout (defaults to the OS temp dir). */
  tmpRoot?: string
}

/** Full 40-hex commit id — a pinned SHA needs no ls-remote verification. */
const FULL_SHA = /^[0-9a-f]{40}$/i

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/**
 * Generic git registry provider (`git:` / scp-style sources): pins a ref to a
 * commit SHA with `git ls-remote`, materializes the skill subtree of a
 * checkout into the download directory, and reports the current HEAD as the
 * latest revision. Search returns no hits — arbitrary git hosts cannot be
 * searched; users install from an explicit URL.
 *
 * Transports use the machine's own git credentials (no credential bridge):
 * private remotes must be reachable through the user's git configuration.
 */
export class GitSourceProvider implements RegistryProvider {
  readonly id = 'git'

  private readonly git: GitClient
  private readonly tmpRoot: string

  constructor(options: GitSourceProviderOptions = {}) {
    this.git = options.git ?? new GitClient()
    this.tmpRoot = options.tmpRoot ?? os.tmpdir()
  }

  async search(_query: string): Promise<RegistrySearchResult[]> {
    return []
  }

  /** Pins `source.ref` (or `HEAD`) to a concrete commit SHA. */
  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    if (source.type !== 'git') {
      throw unsupported(source)
    }
    return { source, revision: await this.pinRevision(source) }
  }

  /** Latest revision for `source` — the remote `HEAD` (or the pinned ref). */
  async getLatestRevision(source: NormalizedSource): Promise<string> {
    if (source.type !== 'git') {
      throw unsupported(source)
    }
    return this.pinRevision(source)
  }

  /**
   * Materializes the skill subtree of `source` at `revision` into `targetDir`
   * (created as needed): clone-or-checkout into a temp dir, copy the subtree
   * (or the whole checkout) over, then drop the temp checkout.
   */
  async download(source: NormalizedSource, revision: string, targetDir: string): Promise<void> {
    if (source.type !== 'git') {
      throw unsupported(source)
    }
    const tmp = path.join(this.tmpRoot, `skillbox-git-${Date.now()}-${process.pid}`)
    try {
      await this.git.materialize({ url: source.url, targetDir: tmp, ref: revision })
    } catch (error) {
      throw toRegistryError(
        error,
        `Git checkout of ${source.url}@${revision} failed`,
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
      )
    }
    try {
      const srcRoot = source.path === undefined ? tmp : resolveInsideRoot(tmp, source.path)
      await fs.mkdir(targetDir, { recursive: true })
      await fs.cp(srcRoot, targetDir, { recursive: true, force: true })
    } catch (error) {
      if (isEnoent(error)) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_NOT_FOUND,
          `Skill path "${source.path ?? ''}" not found in ${source.url}@${revision}`,
          { reason: 'not-found', context: { url: source.url, revision, path: source.path } },
        )
      }
      if (error instanceof RegistryError) {
        throw error
      }
      throw toRegistryError(
        error,
        `Git download of ${source.url}@${revision} failed`,
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
      )
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async pinRevision(source: Extract<NormalizedSource, { type: 'git' }>): Promise<string> {
    const ref = source.ref
    if (ref !== undefined && FULL_SHA.test(ref)) {
      return ref.toLowerCase()
    }
    const remote = await this.git.lsRemote(source.url, ref ?? 'HEAD')
    if (remote === undefined) {
      throw new RegistryError(
        RegistryErrorCode.REGISTRY_NOT_FOUND,
        `Ref "${ref ?? 'HEAD'}" not found at ${source.url}`,
        { reason: 'not-found', context: { url: source.url, ref: ref ?? 'HEAD' } },
      )
    }
    return remote
  }
}

function unsupported(source: NormalizedSource): RegistryError {
  return new RegistryError(
    RegistryErrorCode.SOURCE_UNSUPPORTED,
    `GitSourceProvider cannot handle a "${source.type}" source`,
    { reason: 'source', context: { source } },
  )
}
