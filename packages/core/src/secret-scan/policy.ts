import * as path from 'node:path'
import { z } from 'zod'
import { SkillboxError, ErrorCode } from '../errors.js'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { compileIgnoreGlob } from '../ignore/glob.js'

export const SECRET_POLICY_FILE_NAME = 'secret-policy.json'

/**
 * Persisted Secret Scan policy (SPEC §160 / MVP M13.3). Decisions the user
 * makes when a finding blocks a commit are written here so later scans
 * respect them. The file lives in the Skillbox home, never in the
 * repository. Stored rules are pattern ids, file globs and exact finding
 * keys - no secret material is ever written.
 */
export const secretPolicySchema = z.object({
  version: z.literal(1),
  /** Permanently ignored pattern ids (e.g. `aws-access-key`). */
  ignoredPatterns: z.array(z.string()),
  /** Permanently ignored files (gitignore-style globs, repo-relative). */
  ignoredFiles: z.array(z.string()),
  /** Permanently ignored exact findings: `<file>:<line>:<patternId>`. */
  ignoredFindings: z.array(z.string()),
})

export type SecretPolicy = z.infer<typeof secretPolicySchema>

export function emptySecretPolicy(): SecretPolicy {
  return { version: 1, ignoredPatterns: [], ignoredFiles: [], ignoredFindings: [] }
}

export interface SecretPolicyStoreOptions {
  /** Absolute path of the policy file (`<home>/state/secret-policy.json`). */
  filePath: string
  filesystem?: FilesystemService
}

/** Default policy location inside a Skillbox home root. */
export function defaultSecretPolicyFilePath(homeRoot: string): string {
  return path.join(homeRoot, 'state', SECRET_POLICY_FILE_NAME)
}

/**
 * Canonical key identifying a single finding. `line` is `undefined` for
 * file-level findings and rendered as `0`.
 */
export function findingKey(file: string, line: number | undefined, patternId: string): string {
  const normalized = normalizePolicyFile(file)
  return `${normalized}:${line ?? 0}:${patternId}`
}

function normalizePolicyFile(file: string): string {
  let normalized = file.replace(/\\/g, '/')
  normalized = normalized.replace(/\/{2,}/g, '/')
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  return normalized
}

/**
 * Machine-local Secret Scan policy. Supports `Ignore once` (a transient,
 * session-scoped decision) and `Add to Ignore` (permanent, persisted)
 * without ever treating the scan result as part of Skill Integrity.
 */
export class SecretPolicyStore {
  readonly filePath: string
  private readonly filesystem: FilesystemService
  private policy: SecretPolicy | null = null
  private sessionIgnores = new Set<string>()
  private ignoredFileGlobs: readonly { glob: string; regex: RegExp }[] = []

  constructor(options: SecretPolicyStoreOptions) {
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.filePath = options.filePath
  }

  /** Loads and validates the persisted policy; a missing file yields the empty policy. */
  async load(): Promise<SecretPolicy> {
    if (this.policy !== null) {
      return this.policy
    }
    if (!(await this.filesystem.exists(this.filePath))) {
      this.policy = emptySecretPolicy()
      return this.policy
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.filesystem.readFile(this.filePath))
    } catch (error) {
      throw new SkillboxError(ErrorCode.INVALID_CONFIG, `Failed to parse "${this.filePath}"`, {
        cause: error,
        context: { path: this.filePath },
      })
    }
    const result = secretPolicySchema.safeParse(parsed)
    if (!result.success) {
      throw new SkillboxError(
        ErrorCode.INVALID_CONFIG,
        `Invalid secret scan policy at "${this.filePath}"`,
        { context: { path: this.filePath, issues: result.error.issues } },
      )
    }
    this.policy = result.data
    this.rebuildFileGlobs()
    return this.policy
  }

  /** Atomically persists the policy, then serves it from memory. */
  async save(policy: SecretPolicy): Promise<void> {
    const serialized = `${JSON.stringify(policy, null, 2)}\n`
    await atomicWriteFile(this.filePath, serialized)
    this.policy = policy
    this.rebuildFileGlobs()
  }

  /** Current in-memory policy snapshot (null before the first load/save). */
  get snapshot(): SecretPolicy | null {
    return this.policy
  }

  /**
   * `Ignore once`: ignores the given finding keys for this process session
   * only. Nothing is written to disk.
   */
  ignoreOnce(keys: readonly string[]): void {
    for (const key of keys) {
      this.sessionIgnores.add(key)
    }
  }

  clearSession(): void {
    this.sessionIgnores.clear()
  }

  /** True when `file` matches a permanently ignored file glob. */
  isIgnoredFile(file: string): boolean {
    const normalized = normalizePolicyFile(file)
    return this.ignoredFileGlobs.some((entry) => entry.regex.test(normalized))
  }

  /**
   * True when the finding should be silenced: session (`Ignore once`),
   * persisted finding key, persisted pattern id, or ignored file glob.
   */
  shouldSkip(key: string, patternId: string, file: string): boolean {
    if (this.sessionIgnores.has(key)) {
      return true
    }
    const policy = this.policy
    if (policy === null) {
      return false
    }
    if (policy.ignoredFindings.includes(key)) {
      return true
    }
    if (policy.ignoredPatterns.includes(patternId)) {
      return true
    }
    return this.isIgnoredFile(file)
  }

  /** `Add to Ignore` (pattern): permanently ignores every finding of a pattern id. */
  async addIgnoredPattern(patternId: string): Promise<SecretPolicy> {
    const policy = await this.load()
    if (policy.ignoredPatterns.includes(patternId)) {
      return policy
    }
    const next: SecretPolicy = {
      ...policy,
      ignoredPatterns: [...policy.ignoredPatterns, patternId],
    }
    await this.save(next)
    return next
  }

  /** `Add to Ignore` (file): permanently ignores a repo-relative file glob. */
  async addIgnoredFile(file: string): Promise<SecretPolicy> {
    const normalized = normalizePolicyFile(file)
    const policy = await this.load()
    if (policy.ignoredFiles.includes(normalized)) {
      return policy
    }
    const next: SecretPolicy = {
      ...policy,
      ignoredFiles: [...policy.ignoredFiles, normalized],
    }
    await this.save(next)
    return next
  }

  /** `Add to Ignore` (finding): permanently ignores one exact finding key. */
  async addIgnoredFinding(key: string): Promise<SecretPolicy> {
    const policy = await this.load()
    if (policy.ignoredFindings.includes(key)) {
      return policy
    }
    const next: SecretPolicy = {
      ...policy,
      ignoredFindings: [...policy.ignoredFindings, key],
    }
    await this.save(next)
    return next
  }

  private rebuildFileGlobs(): void {
    const policy = this.policy
    if (policy === null) {
      this.ignoredFileGlobs = []
      return
    }
    this.ignoredFileGlobs = policy.ignoredFiles.flatMap((glob) => {
      const compiled = compileIgnoreGlob(glob)
      return compiled === null ? [] : [{ glob, regex: compiled.regex }]
    })
  }
}
