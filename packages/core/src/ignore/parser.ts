import { compileIgnoreGlob } from './glob.js'
import { isIgnoreScope, type IgnoreScope } from './scopes.js'

export interface ParsedIgnoreRule {
  /** Original raw line (minus scope/negation markers) for diagnostics. */
  pattern: string
  /** Scope marker when the line used the `scope:` prefix (SPEC §106-109). */
  scope?: IgnoreScope
  /** True for `!` patterns that re-include a previously ignored path. */
  negated: boolean
  /** True when the pattern is directory-only (trailing `/`). */
  dirOnly: boolean
  /** Compiled matcher for `/`-separated relative paths. */
  regex: RegExp
}

const SCOPE_PREFIX = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/u

/**
 * Parses the text of a `.skillboxignore` file. The syntax is `.gitignore`-
 * compatible (comments, blank lines, `*`/`**`/`?` globs, `!` negation,
 * directory `/` suffix, leading-slash anchoring) with one extension: a rule
 * can be limited to a workflow with the `scope:` prefix, e.g. `scan: *.key`
 * or `!scan: important.key`. Rules without a scope marker apply to every
 * workflow. Invalid lines are skipped instead of throwing.
 */
export function parseSkillboxIgnore(text: string): ParsedIgnoreRule[] {
  const rules: ParsedIgnoreRule[] = []
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index++) {
    let content = lines[index]!
    if (index === 0 && content.charCodeAt(0) === 0xfeff) {
      content = content.slice(1)
    }
    content = content.replace(/\s+$/u, '')

    if (content.startsWith('\\!') || content.startsWith('\\#') || content.startsWith('\\ ')) {
      content = content.slice(1)
    }
    if (content === '' || content.startsWith('#')) {
      continue
    }

    let negated = false
    let rest = content
    if (rest.startsWith('!')) {
      negated = true
      rest = rest.slice(1)
    }

    let scope: IgnoreScope | undefined
    const scopeMatch = SCOPE_PREFIX.exec(rest)
    if (scopeMatch !== null) {
      if (isIgnoreScope(scopeMatch[1]!)) {
        scope = scopeMatch[1]!
        rest = scopeMatch[2]!
      } else {
        // A `token:` prefix with an unknown scope is a typo; skip the line
        // rather than silently turning it into a literal pattern.
        continue
      }
    }
    rest = rest.trim()
    if (rest.startsWith('!')) {
      negated = true
      rest = rest.slice(1)
    }
    rest = rest.trim()
    if (rest === '') {
      continue
    }

    const compiled = compileIgnoreGlob(rest)
    if (compiled === null) {
      continue
    }
    const rule: ParsedIgnoreRule = {
      pattern: content,
      negated,
      dirOnly: compiled.dirOnly,
      regex: compiled.regex,
    }
    if (scope !== undefined) {
      rule.scope = scope
    }
    rules.push(rule)
  }
  return rules
}
