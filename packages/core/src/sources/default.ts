import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ErrorCode, SkillboxError } from '../errors.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { GitClient } from '../git/index.js'
import {
  defaultRegistry,
  GitHubProvider,
  LocalProvider,
  SkillsShProvider,
  type ProviderRegistry,
} from '../registry/index.js'
import type { NormalizedSource, RegistryProvider } from '../registry/types.js'
import { createSkillSourceResolver } from './resolver.js'
import type { CanonicalSkillSource, SkillSourceAdapter, SkillSourceResolver } from './types.js'

/**
 * Production adapters for the canonical source boundary.  Legacy registry
 * providers remain the implementation behind GitHub, skills.sh and local,
 * but callers no longer need to select or reshape them themselves.
 */
export interface CreateDefaultSkillSourceResolverOptions {
  registry?: ProviderRegistry
  git?: GitClient
  temporaryRoot?: string
}

function unsupported(source: CanonicalSkillSource, capability: string): SkillboxError {
  return new SkillboxError(
    ErrorCode.SOURCE_UNSUPPORTED,
    `Skill source type "${source.type}" does not support ${capability}`,
    { context: { sourceType: source.type, capability }, recoverable: true },
  )
}

function legacySource(source: CanonicalSkillSource): NormalizedSource {
  switch (source.type) {
    case 'github':
      return {
        type: 'github',
        repo: source.repo,
        ...(source.path === undefined ? {} : { path: source.path }),
        ...(source.ref === undefined ? {} : { ref: source.ref }),
      }
    case 'registry':
      if (source.registry === 'skills.sh') {
        return {
          type: 'skills-sh',
          package: source.package,
          ...(source.version === undefined ? {} : { version: source.version }),
        }
      }
      break
    case 'local':
      return { type: 'local', path: source.path }
    case 'git':
      break
  }
  throw unsupported(source, 'provider dispatch')
}

function providerFor(registry: ProviderRegistry, source: CanonicalSkillSource): RegistryProvider {
  const normalized = legacySource(source)
  try {
    return registry.resolveProvider(normalized.type)
  } catch (error) {
    if (error instanceof SkillboxError && error.code === ErrorCode.SOURCE_UNSUPPORTED) {
      throw unsupported(source, 'provider dispatch')
    }
    throw error
  }
}

function providerAdapter(
  type: 'github' | 'registry' | 'local',
  registry: ProviderRegistry,
): SkillSourceAdapter {
  return {
    type,
    capabilities: { resolve: true, download: true, latest: true, materialize: true },
    async resolve(source) {
      const resolved = await providerFor(registry, source).resolve(legacySource(source))
      return {
        source,
        revision: resolved.revision,
        ...(resolved.integrity === undefined ? {} : { integrity: resolved.integrity }),
      }
    },
    async download(source, revision, targetDir) {
      await providerFor(registry, source).download(legacySource(source), revision, targetDir)
    },
    async latest(source) {
      return providerFor(registry, source).getLatestRevision(legacySource(source))
    },
    async materialize(source, revision, targetDir) {
      await providerFor(registry, source).download(legacySource(source), revision, targetDir)
    },
  }
}

function gitAdapter(git: GitClient, temporaryRoot: string): SkillSourceAdapter {
  const checkout = async (
    source: CanonicalSkillSource,
    ref: string | undefined,
  ): Promise<string> => {
    if (source.type !== 'git') throw unsupported(source, 'git materialization')
    await fs.mkdir(temporaryRoot, { recursive: true })
    const root = await fs.mkdtemp(path.join(temporaryRoot, 'skillbox-git-'))
    try {
      await git.materialize({
        url: source.url,
        targetDir: root,
        ...(ref === undefined ? {} : { ref }),
      })
      return root
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true })
      throw error
    }
  }
  const latest = async (source: CanonicalSkillSource): Promise<string> => {
    const root = await checkout(source, source.type === 'git' ? source.ref : undefined)
    try {
      return await git.revParse(root, 'HEAD')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
  const materialize = async (
    source: CanonicalSkillSource,
    revision: string,
    targetDir: string,
  ): Promise<void> => {
    if (source.type !== 'git') throw unsupported(source, 'git materialization')
    const root = await checkout(source, revision)
    try {
      const content = source.path === undefined ? root : resolveInsideRoot(root, source.path)
      await fs.mkdir(targetDir, { recursive: true })
      await fs.cp(content, targetDir, { recursive: true, errorOnExist: false })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
  return {
    type: 'git',
    capabilities: { resolve: true, download: true, latest: true, materialize: true },
    async resolve(source) {
      return { source, revision: await latest(source) }
    },
    latest,
    async download(source, revision, targetDir) {
      await materialize(source, revision, targetDir)
    },
    materialize,
  }
}

/**
 * Builds the resolver used by production entry points.  Unknown registry
 * names deliberately retain a stable `SOURCE_UNSUPPORTED` result instead of
 * falling through to an unrelated provider or legacy parser error.
 */
export function createDefaultSkillSourceResolver(
  options: CreateDefaultSkillSourceResolverOptions = {},
): SkillSourceResolver {
  const registry = options.registry ?? defaultRegistry
  // Entry points may construct the resolver before Marketplace has run.  The
  // canonical production path must still have the first-party adapters.
  for (const create of [
    () => new GitHubProvider(),
    () => new SkillsShProvider(),
    () => new LocalProvider(),
  ]) {
    const provider = create()
    if (!registry.hasProvider(provider.id)) registry.registerProvider(provider)
  }
  const git = options.git ?? new GitClient()
  const temporaryRoot = options.temporaryRoot ?? path.join(os.tmpdir(), 'skillbox')
  return createSkillSourceResolver({
    adapters: [
      providerAdapter('github', registry),
      providerAdapter('registry', registry),
      providerAdapter('local', registry),
      gitAdapter(git, temporaryRoot),
    ],
  })
}
