import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { parseSkillboxIgnore, type ParsedIgnoreRule } from './parser.js'
import type { IgnoreScope } from './scopes.js'

export const SKILLBOX_IGNORE_FILE_NAME = '.skillboxignore'

export interface IgnoreMatchOptions {
  /**
   * When set, only un-scoped rules plus rules carrying this scope marker are
   * evaluated. Without a scope, un-scoped rules still apply and scoped rules
   * are ignored, so scoping never bleeds into unrelated workflows.
   */
  scope?: IgnoreScope
}

export interface IgnoreMatcher {
  /** Last-match-wins `.gitignore` evaluation against `relativePath`. */
  matches(relativePath: string, options?: IgnoreMatchOptions): boolean
}

export interface SkillboxIgnoreOptions {
  rules?: readonly ParsedIgnoreRule[]
}

/**
 * Evaluator for `.skillboxignore` files. Follows `.gitignore` semantics
 * (last matching rule wins) and supports workflow scopes: a rule prefixed
 * with `import:` / `sync:` / `scan:` / `backup:` only applies to that
 * workflow, while un-scoped rules apply everywhere.
 */
export class SkillboxIgnore implements IgnoreMatcher {
  private readonly rules: readonly ParsedIgnoreRule[]

  constructor(options: SkillboxIgnoreOptions = {}) {
    this.rules = options.rules ?? []
  }

  static fromText(text: string): SkillboxIgnore {
    return new SkillboxIgnore({ rules: parseSkillboxIgnore(text) })
  }

  static empty(): SkillboxIgnore {
    return new SkillboxIgnore()
  }

  get ruleCount(): number {
    return this.rules.length
  }

  matches(relativePath: string, options: IgnoreMatchOptions = {}): boolean {
    const normalized = normalizeIgnorePath(relativePath)
    const scope = options.scope
    let ignored = false
    for (const rule of this.rules) {
      if (rule.scope !== undefined && rule.scope !== scope) {
        continue
      }
      if (rule.regex.test(normalized)) {
        ignored = !rule.negated
      }
    }
    return ignored
  }
}

function normalizeIgnorePath(relativePath: string): string {
  let normalized = relativePath.replace(/\\/g, '/')
  normalized = normalized.replace(/\/{2,}/g, '/')
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  return normalized
}

export interface LoadSkillboxIgnoreOptions {
  filesystem?: FilesystemService
}

/**
 * Loads `<root>/.skillboxignore`. Missing or unreadable files yield an empty
 * matcher that ignores nothing, so existing behavior is preserved when no
 * ignore file exists.
 */
export async function loadSkillboxIgnore(
  root: string,
  options: LoadSkillboxIgnoreOptions = {},
): Promise<SkillboxIgnore> {
  const filesystem = options.filesystem ?? new FilesystemService()
  const ignoreFile = path.join(root, SKILLBOX_IGNORE_FILE_NAME)
  if (!(await filesystem.exists(ignoreFile))) {
    return SkillboxIgnore.empty()
  }
  const text = await filesystem.readFile(ignoreFile)
  return SkillboxIgnore.fromText(text)
}

/** Absolute path of the `.skillboxignore` file for a skill/repo root. */
export function skillboxIgnorePath(root: string): string {
  return path.join(root, SKILLBOX_IGNORE_FILE_NAME)
}
