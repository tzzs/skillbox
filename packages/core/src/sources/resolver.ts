import { ErrorCode, SkillboxError } from '../errors.js'
import type { ManifestSkillSource } from '../manifest/schema.js'
import { parseSource as parseLegacySource } from '../registry/source.js'
import type {
  CanonicalSkillSource,
  SkillSourceAdapter,
  SkillSourceCapabilities,
  SkillSourceResolver,
  SkillSourceType,
} from './types.js'

const NO_CAPABILITIES: SkillSourceCapabilities = {
  resolve: false,
  download: false,
  latest: false,
  materialize: false,
}

function sourceInvalid(input: string, detail: string): SkillboxError {
  return new SkillboxError(ErrorCode.SOURCE_INVALID, `Invalid skill source "${input}": ${detail}`, {
    context: { input },
  })
}

function sourceUnsupported(
  sourceType: SkillSourceType,
  capability: keyof SkillSourceCapabilities,
): SkillboxError {
  return new SkillboxError(
    ErrorCode.SOURCE_UNSUPPORTED,
    `Skill source type "${sourceType}" does not support ${capability}`,
    { context: { sourceType, capability }, recoverable: true },
  )
}

function cloneSource(source: ManifestSkillSource): CanonicalSkillSource {
  switch (source.type) {
    case 'github':
      return { ...source }
    case 'git':
      return { ...source }
    case 'registry':
      return { ...source }
    case 'local':
      return { ...source }
  }
}

function parseGit(input: string): CanonicalSkillSource {
  const expression = input.slice('git:'.length)
  const hashIndex = expression.lastIndexOf('#')
  const withoutRef = hashIndex === -1 ? expression : expression.slice(0, hashIndex)
  const ref = hashIndex === -1 ? undefined : expression.slice(hashIndex + 1)
  // An SSH transport URL itself can contain `git@host`; only an `@` after the
  // final path separator denotes the optional skill subdirectory.
  const lastAtIndex = withoutRef.lastIndexOf('@')
  const atIndex = lastAtIndex > withoutRef.lastIndexOf('/') ? lastAtIndex : -1
  const url = atIndex === -1 ? withoutRef : withoutRef.slice(0, atIndex)
  const skillPath = atIndex === -1 ? undefined : withoutRef.slice(atIndex + 1)

  if (url.trim().length === 0) throw sourceInvalid(input, 'git URL must not be empty')
  if (skillPath !== undefined && skillPath.trim().length === 0) {
    throw sourceInvalid(input, 'skill path must not be empty')
  }
  if (ref !== undefined && ref.trim().length === 0)
    throw sourceInvalid(input, 'ref must not be empty')
  if (skillPath?.split(/[\\/]/).includes('..')) {
    throw sourceInvalid(input, 'skill path must not contain ".." segments')
  }

  return {
    type: 'git',
    url,
    ...(skillPath === undefined ? {} : { path: skillPath.replace(/\\/g, '/') }),
    ...(ref === undefined ? {} : { ref }),
  }
}

function parseRegistry(input: string): CanonicalSkillSource {
  const expression = input.slice('registry:'.length)
  const hashIndex = expression.lastIndexOf('#')
  const packageExpression = hashIndex === -1 ? expression : expression.slice(0, hashIndex)
  const version = hashIndex === -1 ? undefined : expression.slice(hashIndex + 1)
  const slashIndex = packageExpression.indexOf('/')
  if (slashIndex <= 0 || slashIndex === packageExpression.length - 1) {
    throw sourceInvalid(input, 'expected registry:<registry>/<package>')
  }
  if (version !== undefined && version.trim().length === 0) {
    throw sourceInvalid(input, 'version must not be empty')
  }
  return {
    type: 'registry',
    registry: packageExpression.slice(0, slashIndex),
    package: packageExpression.slice(slashIndex + 1),
    ...(version === undefined ? {} : { version }),
  }
}

/** Parses a canonical expression while retaining every manifest source kind. */
export function parse(input: string): CanonicalSkillSource {
  const trimmed = input.trim()
  if (/^git:/i.test(trimmed)) return parseGit(trimmed)
  if (/^registry:/i.test(trimmed)) return parseRegistry(trimmed)

  const legacy = parseLegacySource(input)
  switch (legacy.type) {
    case 'github':
      return {
        type: 'github',
        repo: legacy.repo,
        ...(legacy.path === undefined ? {} : { path: legacy.path }),
        ...(legacy.ref === undefined ? {} : { ref: legacy.ref }),
      }
    case 'skills-sh':
      return {
        type: 'registry',
        registry: 'skills.sh',
        package: legacy.package,
        ...(legacy.version === undefined ? {} : { version: legacy.version }),
      }
    case 'local':
      return { type: 'local', path: legacy.path }
  }
}

/** Serializes canonical sources without losing source-specific fields. */
export function serialize(source: CanonicalSkillSource): string {
  switch (source.type) {
    case 'github': {
      let value = `github:${source.repo}`
      if (source.path !== undefined) value += `@${source.path}`
      if (source.ref !== undefined) value += `#${source.ref}`
      return value
    }
    case 'git': {
      let value = `git:${source.url}`
      if (source.path !== undefined) value += `@${source.path}`
      if (source.ref !== undefined) value += `#${source.ref}`
      return value
    }
    case 'registry': {
      let value = `registry:${source.registry}/${source.package}`
      if (source.version !== undefined) value += `#${source.version}`
      return value
    }
    case 'local':
      return source.path
  }
}

/** Maps the schema-backed representation into the canonical model losslessly. */
export function fromManifest(source: ManifestSkillSource): CanonicalSkillSource {
  return cloneSource(source)
}

/** Maps the canonical model back into the current manifest schema losslessly. */
export function toManifest(source: CanonicalSkillSource): ManifestSkillSource {
  return cloneSource(source)
}

export interface CreateSkillSourceResolverOptions {
  adapters?: readonly SkillSourceAdapter[]
}

export function createSkillSourceResolver(
  options: CreateSkillSourceResolverOptions = {},
): SkillSourceResolver {
  const adapters = new Map<SkillSourceType, SkillSourceAdapter>()
  for (const adapter of options.adapters ?? []) adapters.set(adapter.type, adapter)

  return {
    parse,
    serialize,
    fromManifest,
    toManifest,
    capabilitiesFor(source) {
      return adapters.get(source.type)?.capabilities ?? NO_CAPABILITIES
    },
    adapterFor(source, capability = 'resolve') {
      const adapter = adapters.get(source.type)
      if (adapter === undefined || !adapter.capabilities[capability]) {
        throw sourceUnsupported(source.type, capability)
      }
      return adapter
    },
  }
}
