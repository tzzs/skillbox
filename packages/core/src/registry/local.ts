import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { computeSkillIntegrity } from '../integrity/index.js'
import { readManifest } from '../manifest/index.js'
import { RegistryError, RegistryErrorCode, isRegistryError, toRegistryError } from './errors.js'
import type {
  NormalizedSource,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
} from './types.js'

/**
 * Local directory registry provider: search (shallow) a base directory,
 * resolve a local skill directory and copy it into a target directory.
 *
 * Local sources have no versions: `revision` is the constant `'local'`.
 * `resolve()` computes the canonical integrity hash of the directory (it is
 * cheap for local data and gives the install transaction a hash to verify
 * against before/after copying).
 */
export interface LocalProviderOptions {
  /** Base directory that `search()` scans one level deep (default `process.cwd()`). */
  root?: string
}

/** Revision constant used for every local source (no versioning). */
export const LOCAL_REVISION = 'local'

export class LocalProvider implements RegistryProvider {
  readonly id = 'local'

  private readonly root: string

  constructor(options: LocalProviderOptions = {}) {
    this.root = options.root ?? process.cwd()
  }

  /** Shallow search: immediate subdirectories of `root`, filtered by query. */
  async search(query: string): Promise<RegistrySearchResult[]> {
    const trimmed = query.trim().toLowerCase()
    let entries
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (isEnoent(error)) {
        return []
      }
      throw toRegistryError(error, 'Local search failed', RegistryErrorCode.REGISTRY_SEARCH_FAILED)
    }
    const results: RegistrySearchResult[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        // Dot-directories are tooling internals (.git, .skillbox, .claude),
        // never skills.
        continue
      }
      const dirPath = path.join(this.root, entry.name)
      const { name, description } = await readSkillIdentity(dirPath, entry.name)
      if (
        trimmed.length > 0 &&
        !name.toLowerCase().includes(trimmed) &&
        !description.toLowerCase().includes(trimmed)
      ) {
        continue
      }
      results.push({
        name,
        source: dirPath,
        popularity: 0,
        security: 'unknown',
        description,
      })
    }
    results.sort((left, right) => left.name.localeCompare(right.name))
    return results
  }

  /** Pins a local directory: `revision = 'local'`, integrity computed on the spot. */
  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    if (source.type !== 'local') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `LocalProvider cannot resolve a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    try {
      const stat = await fs.stat(source.path)
      if (!stat.isDirectory()) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_NOT_FOUND,
          `Local skill path is not a directory: "${source.path}"`,
          { reason: 'not-found', context: { path: source.path } },
        )
      }
      const integrity = await computeSkillIntegrity(source.path)
      return { source, revision: LOCAL_REVISION, integrity }
    } catch (error) {
      if (isEnoent(error)) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_NOT_FOUND,
          `Local skill directory does not exist: "${source.path}"`,
          { reason: 'not-found', context: { path: source.path } },
        )
      }
      if (isRegistryError(error)) {
        throw error
      }
      throw toRegistryError(error, 'Local resolve failed')
    }
  }

  /** Copies the skill directory contents into `targetDir` (created as needed). */
  async download(source: NormalizedSource, _revision: string, targetDir: string): Promise<void> {
    if (source.type !== 'local') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `LocalProvider cannot download a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    try {
      await fs.mkdir(targetDir, { recursive: true })
      const entries = await fs.readdir(source.path, { withFileTypes: true })
      for (const entry of entries) {
        const srcPath = path.join(source.path, entry.name)
        const destPath = path.join(targetDir, entry.name)
        if (entry.isDirectory()) {
          await fs.cp(srcPath, destPath, { recursive: true, errorOnExist: false })
        } else {
          await fs.cp(srcPath, destPath, { errorOnExist: false })
        }
      }
    } catch (error) {
      if (isEnoent(error)) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_NOT_FOUND,
          `Local skill directory does not exist: "${source.path}"`,
          { reason: 'not-found', context: { path: source.path } },
        )
      }
      throw toRegistryError(
        error,
        'Local download failed',
        RegistryErrorCode.REGISTRY_DOWNLOAD_FAILED,
      )
    }
  }

  /** Local sources have no upstream versions; the current state is always latest. */
  async getLatestRevision(source: NormalizedSource): Promise<string> {
    if (source.type !== 'local') {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `LocalProvider cannot resolve a "${source.type}" source`,
        { reason: 'source' },
      )
    }
    try {
      await fs.stat(source.path)
    } catch (error) {
      if (isEnoent(error)) {
        throw new RegistryError(
          RegistryErrorCode.REGISTRY_NOT_FOUND,
          `Local skill directory does not exist: "${source.path}"`,
          { reason: 'not-found', context: { path: source.path } },
        )
      }
      throw toRegistryError(error, 'Local getLatestRevision failed')
    }
    return LOCAL_REVISION
  }
}

/** Reads `skillbox.yaml` name/description; falls back to the directory name. */
async function readSkillIdentity(
  dirPath: string,
  fallbackName: string,
): Promise<{ name: string; description: string }> {
  try {
    const manifest = await readManifest(dirPath)
    return {
      name: manifest.name ?? fallbackName,
      description: manifest.description ?? '',
    }
  } catch {
    // Missing or invalid manifest: still list the directory, by its name.
    return { name: fallbackName, description: '' }
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
