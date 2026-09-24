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
  // `git:<url>[@<skill path>][#<ref>]` — the optional skill subdirectory is
  // what follows the last `@`. The split only applies when the part before
  // the `@` looks like a URL with a host path (a `/` after the scheme), and
  // the part after it has no `:` (scp-style `git@host:repo` stays one URL,
  // as do authenticated `https://token@host/...` URLs). Keep this rule in
  // sync with the registry parser in registry/source.ts.
  const lastAtIndex = withoutRef.lastIndexOf('@')
  let atIndex = -1
  if (lastAtIndex !== -1) {
    const before = withoutRef.slice(0, lastAtIndex)
    const after = withoutRef.slice(lastAtIndex + 1)
    const schemeEnd = before.indexOf('://')
    const hasHostPath = before.includes('/', schemeEnd === -1 ? 0 : schemeEnd + 3)
    if (hasHostPath && after.length > 0 && !after.includes(':')) {
      atIndex = lastAtIndex
    }
  }
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
        ...(legacy.path === undefined ? {} : { path: legacy.path }),
        ...(legacy.version === undefined ? {} : { version: legacy.version }),
      }
    case 'git':
      return {
        type: 'git',
        url: legacy.url,
        ...(legacy.path === undefined ? {} : { path: legacy.path }),
        ...(legacy.ref === undefined ? {} : { ref: legacy.ref }),
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
