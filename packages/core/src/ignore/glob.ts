const REGEX_SPECIAL_CHARS = new Set(['.', '+', '(', ')', '^', '$', '{', '}', '|', '[', ']', '\\'])

const REGEX_LITERAL_ESCAPE = /[.*+?^${}()|[\]\\]/u

function escapeRegexChar(ch: string): string {
  return `\\${ch}`
}

function escapeLiteral(ch: string): string {
  return REGEX_LITERAL_ESCAPE.test(ch) ? `\\${ch}` : ch
}

/**
 * Translates one path segment of a gitignore glob into a regex source.
 * `*` => any run of non-slash chars, `**` (within a segment) => any chars,
 * `?` => one non-slash char, `[abc]` / `[!abc]` => character classes.
 * Backslash escapes the following character. All other regex metacharacters
 * are escaped so they match literally.
 */
function translateSegment(segment: string): string {
  let out = ''
  let i = 0
  while (i < segment.length) {
    const ch = segment[i]!
    if (ch === '*') {
      let starCount = 0
      while (segment[i] === '*') {
        starCount++
        i++
      }
      out += starCount >= 2 ? '.*' : '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i++
      continue
    }
    if (ch === '[') {
      let j = i + 1
      let inner = ''
      if (segment[j] === '!' || segment[j] === '^') {
        inner += '^'
        j++
      }
      if (segment[j] === ']') {
        inner += '\\]'
        j++
      }
      let closed = false
      while (j < segment.length) {
        const c = segment[j]!
        if (c === ']') {
          closed = true
          break
        }
        inner += c === '\\' ? '\\\\' : c
        j++
      }
      if (closed) {
        out += `[${inner}]`
        i = j + 1
        continue
      }
      out += '\\['
      i++
      continue
    }
    if (ch === '\\') {
      const next = segment[i + 1]
      if (next !== undefined) {
        out += escapeLiteral(next)
        i += 2
        continue
      }
      out += '\\\\'
      i++
      continue
    }
    if (REGEX_SPECIAL_CHARS.has(ch)) {
      out += escapeRegexChar(ch)
    } else {
      out += ch
    }
    i++
  }
  return out
}

export interface CompiledIgnoreGlob {
  /** The original pattern text (without scope/negation markers). */
  pattern: string
  /** Anchored regex mirroring the `.gitignore` semantics of the pattern. */
  regex: RegExp
  /** True when the pattern ended with `/` and therefore matches directories. */
  dirOnly: boolean
}

/**
 * Compiles a `.gitignore`-compatible pattern into a regex matched against a
 * `/`-separated relative path:
 *
 * - no slash (after stripping a trailing `/`) => the pattern also matches a
 *   file or directory of that name at any nesting level;
 * - a slash anywhere else anchors the pattern to the root of the ignore file;
 * - a leading double-star-slash prefix matches in all directories;
 * - a trailing slash-star-star suffix matches everything inside;
 * - `**` between slashes matches zero or more directories;
 * - a trailing `/` restricts the pattern to directories;
 * - `!` negation and `#` comments are handled by the parser, not here.
 *
 * Returns `null` for the empty / `/` pattern, which matches nothing useful.
 */
export function compileIgnoreGlob(pattern: string): CompiledIgnoreGlob | null {
  let raw = pattern.replace(/\r$/u, '')
  if (raw.length === 0) {
    return null
  }
  let dirOnly = false
  if (raw.endsWith('/')) {
    dirOnly = true
    raw = raw.slice(0, -1)
  }
  const leadingSlash = raw.startsWith('/')
  if (leadingSlash) {
    raw = raw.slice(1)
  }
  let inAllDirectories = false
  if (raw.startsWith('**/')) {
    inAllDirectories = true
    raw = raw.slice(3)
  }

  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) {
    return { pattern, regex: /^.*$/u, dirOnly }
  }

  const translated: string[] = []
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (segment === '**') {
      translated.push(index === segments.length - 1 ? '.*' : '(?:.*/)?')
      continue
    }
    translated.push(translateSegment(segment))
  }
  let body = ''
  let skipSlash = false
  for (let index = 0; index < translated.length; index++) {
    const part = translated[index]!
    if (index > 0 && !skipSlash) {
      body += '/'
    }
    body += part
    skipSlash = part === '(?:.*/)?'
  }

  const anchored = leadingSlash || raw.includes('/')
  let source: string
  if (inAllDirectories) {
    source = `(?:.*/)?${body}$`
  } else if (anchored) {
    source = dirOnly ? `^${body}(?:/.*)?$` : `^${body}$`
  } else {
    source = dirOnly ? `(?:^|/)${body}(?:/.*)?$` : `(?:^|/)${body}$`
  }
  return { pattern, regex: new RegExp(source, 'u'), dirOnly }
}

/** Convenience: does `relativePath` match the compiled glob? */
export function matchIgnoreGlob(compiled: CompiledIgnoreGlob, relativePath: string): boolean {
  return compiled.regex.test(relativePath.replace(/\\/g, '/'))
}
