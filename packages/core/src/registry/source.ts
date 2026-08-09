import * as path from 'node:path'
import { ErrorCode, SkillboxError } from '../errors.js'
import type { ManifestSkillSource } from '../manifest/schema.js'
import type { NormalizedSource } from './types.js'

/**
 * Source parsing and normalization (SKILLBOX_SPEC §23, MVP M14.5).
 *
 * Different user inputs can denote the same source; every input is reduced to
 * one canonical `NormalizedSource`:
 *
 * | input                                | normalized                       |
 * | ------------------------------------ | -------------------------------- |
 * | `github:org/repo`                    | `{type:'github', repo}`          |
 * | `https://github.com/org/repo`        | `{type:'github', repo}`          |
 * | `org/repo@path/to/skill`             | `{type:'github', repo, path}`    |
 * | `org/repo#main`                      | `{type:'github', repo, ref}`     |
 * | `https://github.com/org/repo/tree/main/p` | `{type:'github', repo, ref, path}` |
 * | `skills.sh/<name>`                   | `{type:'skills-sh', package}`    |
 * | `./dir`, `C:\dir`, `/abs/dir`        | `{type:'local', path}`           |
 *
 * The lockfile stores the normalized form; the manifest may keep the
 * user-readable expression (SPEC §23). Use {@link toManifestSource} when the
 * manifest/lockfile schema (`ManifestSkillSource`) is required.
 *
 * A bare relative path without `./`/`../` (e.g. `dir/sub`) is treated as a
 * GitHub shorthand (`dir/sub` → owner `dir`, repo `sub`) per MVP M14.5.
 */

/** Matches a GitHub `owner/repo` pair (case-insensitive, kept lowercase). */
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

const UNSUPPORTED_SCHEMES = ['git:', 'gitlab:', 'bitbucket:', 'ssh:', 'file:', 'git@']

/** GitHub shorthand expression without scheme: `owner/repo[@path][#ref]`. */
const GITHUB_EXPRESSION =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:@[^#@\s]+)?(?:#[^\s@#]+)?$/

function invalidSource(input: string, detail: string): SkillboxError {
  return new SkillboxError(ErrorCode.SOURCE_INVALID, `Invalid skill source "${input}": ${detail}`, {
    context: { input },
  })
}

function unsupportedSource(input: string, scheme: string): SkillboxError {
  return new SkillboxError(ErrorCode.SOURCE_UNSUPPORTED, `Unsupported skill source "${input}"`, {
    context: { input, scheme },
  })
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

/**
 * Validates a repo-relative skill path: `/`-separated, no empty segments and
 * no `..` traversal. Backslashes are normalized to `/` (Windows users).
 */
function normalizeSkillPath(value: string, input: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const trimmed = trimSlashes(normalized)
  if (trimmed.length === 0) {
    throw invalidSource(input, 'skill path must not be empty')
  }
  for (const segment of trimmed.split('/')) {
    if (segment === '..') {
      throw invalidSource(input, 'skill path must not contain ".." segments')
    }
    if (segment.length === 0) {
      throw invalidSource(input, 'skill path must not contain empty segments')
    }
  }
  return trimmed
}

/** Validates a ref/branch/tag pin: non-empty and free of whitespace. */
function normalizeRef(value: string, input: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw invalidSource(input, 'ref must not be empty')
  }
  if (/\s/.test(trimmed)) {
    throw invalidSource(input, 'ref must not contain whitespace')
  }
  return trimmed
}

function parseGithubExpression(input: string, expression: string): NormalizedSource {
  let rest = expression
  let ref: string | undefined
  let skillPath: string | undefined

  const hashIndex = rest.indexOf('#')
  if (hashIndex !== -1) {
    ref = normalizeRef(rest.slice(hashIndex + 1), input)
    rest = rest.slice(0, hashIndex)
  }
  const atIndex = rest.indexOf('@')
  if (atIndex !== -1) {
    skillPath = normalizeSkillPath(rest.slice(atIndex + 1), input)
    rest = rest.slice(0, atIndex)
  }
  if (rest.endsWith('.git')) {
    rest = rest.slice(0, -4)
  }
  const repo = rest.toLowerCase()
  if (!OWNER_REPO.test(repo)) {
    throw invalidSource(input, 'expected "owner/repo"')
  }
  return {
    type: 'github',
    repo,
    ...(skillPath !== undefined ? { path: skillPath } : {}),
    ...(ref !== undefined ? { ref } : {}),
  }
}

/** `https://github.com/owner/repo[/tree/<ref>/<path> | /blob/<ref>/<path>]`. */
function parseGithubUrl(input: string): NormalizedSource {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw invalidSource(input, 'not a valid URL')
  }
  if (url.hostname !== 'github.com') {
    throw unsupportedSource(input, `https://${url.hostname}`)
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2 || segments[0] === undefined || segments[1] === undefined) {
    throw invalidSource(input, 'expected https://github.com/owner/repo')
  }
  const repo = segments[1].replace(/\.git$/, '').toLowerCase()
  if (!OWNER_REPO.test(`${segments[0].toLowerCase()}/${repo}`)) {
    throw invalidSource(input, 'expected https://github.com/owner/repo')
  }
  const result: NormalizedSource = {
    type: 'github',
    repo: `${segments[0].toLowerCase()}/${repo}`,
  }
  if (segments.length > 2) {
    const kind = segments[2]
    if (kind !== 'tree' && kind !== 'blob') {
      throw invalidSource(input, `unsupported GitHub URL shape "/${kind}" (use /tree/<ref>/<path>)`)
    }
    if (segments.length < 5 || segments[3] === undefined) {
      throw invalidSource(input, `expected /${kind}/<ref>/<path>`)
    }
    const ref = normalizeRef(segments[3], input)
    const skillPath = segments.slice(4).join('/')
    if (skillPath.length > 0) {
      result.path = normalizeSkillPath(skillPath, input)
    }
    result.ref = ref
  }
  return result
}

function parseSkillsSh(input: string, expression: string): NormalizedSource {
  const trimmed = trimSlashes(expression)
  if (trimmed.length === 0) {
    throw invalidSource(input, 'expected skills.sh/<package>')
  }
  let rest = trimmed
  let version: string | undefined
  let skillPath: string | undefined

  const hashIndex = rest.indexOf('#')
  if (hashIndex !== -1) {
    version = normalizeRef(rest.slice(hashIndex + 1), input)
    rest = rest.slice(0, hashIndex)
  }
  const atIndex = rest.indexOf('@')
  if (atIndex !== -1) {
    skillPath = normalizeSkillPath(rest.slice(atIndex + 1), input)
    rest = rest.slice(0, atIndex)
  }
  const pkg = trimSlashes(rest)
  if (pkg.length === 0) {
    throw invalidSource(input, 'expected skills.sh/<package>')
  }
  for (const segment of pkg.split('/')) {
    if (segment === '..') {
      throw invalidSource(input, 'package must not contain ".." segments')
    }
  }
  return {
    type: 'skills-sh',
    package: pkg,
    ...(skillPath !== undefined ? { path: skillPath } : {}),
    ...(version !== undefined ? { version } : {}),
  }
}

function isLocalInput(input: string): boolean {
  return (
    input.startsWith('./') ||
    input.startsWith('../') ||
    WINDOWS_DRIVE.test(input) ||
    path.isAbsolute(input)
  )
}

/**
 * Parses a user-facing source expression into its canonical `NormalizedSource`.
 *
 * Throws `SkillboxError` with `SOURCE_INVALID` for unparseable input and
 * `SOURCE_UNSUPPORTED` for recognized-but-unhandled schemes (`git:`, ...).
 */
export function parseSource(input: string): NormalizedSource {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new SkillboxError(ErrorCode.SOURCE_INVALID, 'Skill source must not be empty', {
      context: { input },
    })
  }

  if (isLocalInput(trimmed)) {
    return { type: 'local', path: path.resolve(trimmed) }
  }

  const githubScheme = /^github:/i.exec(trimmed)
  if (githubScheme !== null) {
    const expression = trimSlashes(trimmed.slice(githubScheme[0].length))
    return parseGithubExpression(input, expression)
  }

  if (trimmed.startsWith('skills.sh/')) {
    return parseSkillsSh(input, trimmed.slice('skills.sh/'.length))
  }

  if (trimmed.startsWith('https://github.com/') || trimmed.startsWith('http://github.com/')) {
    return parseGithubUrl(trimmed)
  }

  if (trimmed.startsWith('https://skills.sh/') || trimmed.startsWith('http://skills.sh/')) {
    return parseSkillsSh(input, trimmed.replace(/^https?:\/\//, '').slice('skills.sh/'.length))
  }

  for (const scheme of UNSUPPORTED_SCHEMES) {
    if (trimmed.startsWith(scheme)) {
      throw unsupportedSource(trimmed, scheme)
    }
  }

  if (GITHUB_EXPRESSION.test(trimmed)) {
    return parseGithubExpression(trimmed, trimmed)
  }

  throw invalidSource(
    trimmed,
    'expected github:org/repo, https://github.com/org/repo, org/repo@path, skills.sh/<name>, ./dir or an absolute path',
  )
}

/** Serializes a normalized source back to its canonical string form. */
export function sourceToString(source: NormalizedSource): string {
  switch (source.type) {
    case 'github': {
      let value = `github:${source.repo}`
      if (source.path !== undefined) value += `@${source.path}`
      if (source.ref !== undefined) value += `#${source.ref}`
      return value
    }
    case 'skills-sh': {
      let value = `skills.sh/${source.package}`
      if (source.path !== undefined) value += `@${source.path}`
      if (source.version !== undefined) value += `#${source.version}`
      return value
    }
    case 'local':
      return source.path
  }
}

/**
 * Parses and re-serializes in one step. Useful for lockfile/compare logic:
 * `normalizeSourceString(a) === normalizeSourceString(b)` iff `a` and `b`
 * denote the same source.
 */
export function normalizeSourceString(input: string): string {
  return sourceToString(parseSource(input))
}

/**
 * Converts a normalized source into the manifest/lockfile source shape
 * (`ManifestSkillSource`). The lockfile must persist the normalized source;
 * the manifest may persist the user-readable expression (SPEC §23) — this
 * helper exists for consumers that write to the schema-backed files.
 *
 * Limitations: the manifest schema has no `branch` field (a resolved branch
 * falls back to `ref`) and no skills.sh path (the path is dropped; re-resolution
 * refills it from registry metadata).
 */
export function toManifestSource(source: NormalizedSource): ManifestSkillSource {
  switch (source.type) {
    case 'github':
      return {
        type: 'github',
        repo: source.repo,
        ...(source.path !== undefined ? { path: source.path } : {}),
        ...(source.ref !== undefined
          ? { ref: source.ref }
          : source.branch !== undefined
            ? { ref: source.branch }
            : {}),
      }
    case 'skills-sh':
      return {
        type: 'registry',
        registry: 'skills.sh',
        package: source.package,
        ...(source.version !== undefined ? { version: source.version } : {}),
      }
    case 'local':
      return { type: 'local', path: source.path }
  }
}

/**
 * Inverse of {@link toManifestSource}. Returns `null` when the manifest source
 * has no registry representation (`git` URLs, non-skills.sh registries).
 */
export function fromManifestSource(source: ManifestSkillSource): NormalizedSource | null {
  switch (source.type) {
    case 'github':
      return {
        type: 'github',
        repo: source.repo,
        ...(source.path !== undefined ? { path: source.path } : {}),
        ...(source.ref !== undefined ? { ref: source.ref } : {}),
      }
    case 'registry':
      if (source.registry !== 'skills.sh') {
        return null
      }
      return {
        type: 'skills-sh',
        package: source.package,
        ...(source.version !== undefined ? { version: source.version } : {}),
      }
    case 'local':
      return { type: 'local', path: source.path }
    case 'git':
      return null
  }
}
