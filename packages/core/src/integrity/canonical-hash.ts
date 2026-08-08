import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { toFsError } from '../fs/errors.js'
import { scanDirectory } from '../fs/scanner.js'

/** Standard Integrity format prefix: `sha256:<64 hex chars>`. */
export const INTEGRITY_PREFIX = 'sha256:'

/** Full canonical hash length in hex characters (SHA-256). */
export const INTEGRITY_HASH_LENGTH = 64

export interface FileIntegrityEntry {
  /** Relative file path, forward slashes on every platform. */
  path: string
  /** Per-file SHA-256 hex digest (without the `sha256:` prefix). */
  hash: string
}

/**
 * Runtime metadata directories whose contents must never participate in a
 * Skill Integrity hash (matching the Canonical Hash Algorithm in
 * SKILLBOX_SPEC.md §64, step 2). Applied at any nesting level.
 */
const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.skillbox', '.svn', '.hg'])

const TEXT_SAMPLE_BYTES = 8192

function isIgnoredPath(relativePath: string): boolean {
  for (const segment of relativePath.split('/')) {
    if (IGNORED_DIRECTORY_NAMES.has(segment)) {
      return true
    }
  }
  return false
}

/**
 * Rudimentary text detection: a NUL byte within the first 8KB means binary,
 * so its bytes are hashed without normalization.
 */
function looksLikeText(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, TEXT_SAMPLE_BYTES)
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) {
      return false
    }
  }
  return true
}

/**
 * Normalizes line endings to LF (CRLF and lone CR both collapse to LF). Text
 * files thus hash identically on Windows, macOS and Linux regardless of which
 * line endings are on disk. Binary content is returned untouched.
 */
export function normalizeLineEndings(buffer: Uint8Array): Buffer {
  if (buffer.length === 0 || !looksLikeText(buffer)) {
    return Buffer.from(buffer)
  }
  const output = Buffer.allocUnsafe(buffer.length)
  let written = 0
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]
    if (byte === 0x0d) {
      output[written++] = 0x0a
      if (i + 1 < buffer.length && buffer[i + 1] === 0x0a) {
        i++
      }
    } else {
      output[written++] = byte ?? 0x00
    }
  }
  return Buffer.from(output.subarray(0, written))
}

/**
 * Converts any platform-specific relative path to the portable `/` form used
 * by the Canonical Manifest, so windows-style and posix-style inputs hash
 * identically.
 */
export function normalizeRelativePath(relativePath: string): string {
  let normalized = relativePath.replace(/\\/g, '/')
  normalized = normalized.replace(/\/{2,}/g, '/')
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  return normalized
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** SHA-256 (hex) of one file's canonical bytes. */
export function hashFileContent(content: Uint8Array): string {
  return sha256Hex(normalizeLineEndings(content))
}

function compareByUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Builds the canonical manifest from per-file entries sorted by UTF-8 byte
 * order of the normalized relative path:
 *
 * ```text
 * SKILL.md\0<hash>\n
 * references/foo.md\0<hash>\n
 * ```
 */
export function buildCanonicalManifest(entries: FileIntegrityEntry[]): string {
  const normalized = entries.map((entry) => ({
    path: normalizeRelativePath(entry.path),
    hash: entry.hash,
  }))
  normalized.sort((left, right) => compareByUtf8Bytes(left.path, right.path))
  let output = ''
  for (const entry of normalized) {
    output += `${entry.path}\u0000${entry.hash}\n`
  }
  return output
}

/**
 * Deterministic Integrity hash (`sha256:<hex>`) from a list of per-file
 * entries. Independent of scan order and of the host filesystem layout.
 */
export function computeIntegrityFromEntries(entries: FileIntegrityEntry[]): string {
  const canonical = buildCanonicalManifest(entries)
  return `${INTEGRITY_PREFIX}${sha256Hex(Buffer.from(canonical, 'utf8'))}`
}

async function readFileBytes(target: string): Promise<Buffer> {
  try {
    return await fs.readFile(target)
  } catch (error) {
    throw toFsError(error, `Failed to read skill file "${target}"`, target)
  }
}

async function collectFileEntries(skillRoot: string): Promise<FileIntegrityEntry[]> {
  const scan = await scanDirectory(skillRoot)
  const entries: FileIntegrityEntry[] = []
  for (const filePath of scan.files) {
    const relativePath = normalizeRelativePath(filePath)
    if (isIgnoredPath(relativePath)) {
      continue
    }
    const absolute = path.join(scan.root, filePath)
    const content = await readFileBytes(absolute)
    entries.push({ path: relativePath, hash: hashFileContent(content) })
  }
  return entries
}

/**
 * Computes the Canonical Skill Hash for a skill directory: scan files, sort
 * by normalized `/` relative path, hash each file (LF-normalized for text),
 * then SHA-256 the canonical manifest. Returns `sha256:<hex>`.
 */
export async function computeSkillIntegrity(skillRoot: string): Promise<string> {
  const entries = await collectFileEntries(skillRoot)
  return computeIntegrityFromEntries(entries)
}
