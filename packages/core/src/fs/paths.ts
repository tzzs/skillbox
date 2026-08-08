import path from 'node:path'
import { SkillboxError, ErrorCode } from './errors.js'

export function unsafePathError(message: string): SkillboxError {
  return new SkillboxError(ErrorCode.UNSAFE_PATH, `Unsafe path: ${message}`)
}

export function normalizePathSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

const DRIVE_PREFIX = /^[a-zA-Z]:\//

function isPortableRelSegment(segment: string): boolean {
  return segment !== '' && segment !== '.'
}

export function isPortableRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }
  const normalized = normalizePathSlashes(value.trim())
  if (normalized.startsWith('/')) {
    return false
  }
  if (DRIVE_PREFIX.test(normalized)) {
    return false
  }
  const segments = normalized.split('/').filter(isPortableRelSegment)
  if (segments.length === 0) {
    return false
  }
  for (const segment of segments) {
    if (segment === '..') {
      return false
    }
    if (/^[a-zA-Z]:$/.test(segment)) {
      return false
    }
  }
  return true
}

/**
 * Validates that `value` is safe to use as a repository-relative path and
 * returns a normalized portable form (forward slashes only).
 *
 * Rejects:
 * - empty paths
 * - absolute paths (`/Users/foo`, `\foo`)
 * - Windows drive escapes (`C:\Windows\System32`, `C:/...`)
 * - UNC paths (`//server/share`)
 * - any `..` traversal (`../../../etc/passwd`, `a/../../b`)
 */
export function validateRelativePath(value: string): string {
  if (!isPortableRelativePath(value)) {
    throw unsafePathError(`"${value}" is not a valid repository-relative path`)
  }
  const segments = normalizePathSlashes(value.trim()).split('/').filter(isPortableRelSegment)
  return segments.join('/')
}

/**
 * Joins `relativePath` inside `root` and returns the absolute candidate.
 * Throws `UNSAFE_PATH` when the path is not a portable relative path or would
 * resolve outside of `root`.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  const safeRelative = validateRelativePath(relativePath)
  const rootResolved = path.resolve(root)
  const candidate = path.resolve(rootResolved, ...safeRelative.split('/'))
  if (!isInsideRoot(rootResolved, candidate)) {
    throw unsafePathError(`"${relativePath}" escapes root "${rootResolved}"`)
  }
  return candidate
}

/**
 * Lexical containment check: `candidate` must live under `root`.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root)
  const candidateResolved = path.resolve(candidate)
  const relative = path.relative(rootResolved, candidateResolved)
  if (relative === '') {
    return true
  }
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`)
  return !outside && !path.isAbsolute(relative)
}
