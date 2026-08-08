import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { SkillboxError, ErrorCode, toFsError } from './errors.js'
import { isInsideRoot } from './paths.js'
import type { ScanNode } from './scanner.js'

export interface SymlinkResolution {
  symlinkPath: string
  /** Raw target string as stored in the symlink / reparse point. */
  target: string
  /** Absolute path the symlink resolves to (canonical if the target exists). */
  resolved: string
  insideRoot: boolean
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export async function resolveSymlinkTarget(
  symlinkPath: string,
): Promise<Pick<SymlinkResolution, 'target' | 'resolved'>> {
  let target: string
  try {
    target = await fs.readlink(symlinkPath)
  } catch (error) {
    throw toFsError(error, `Failed to read symlink "${symlinkPath}"`, symlinkPath)
  }

  let resolved = path.resolve(path.dirname(symlinkPath), target)
  try {
    resolved = await fs.realpath(resolved)
  } catch (error) {
    // Broken symlink: fall back to the lexical resolution so a not-yet-created
    // internal target is still accepted; escaping targets are caught by
    // `isInsideRoot` regardless.
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw toFsError(error, `Failed to resolve symlink "${symlinkPath}"`, symlinkPath)
    }
  }
  return { target, resolved }
}

/**
 * Resolves `symlinkPath` and checks whether its target stays inside `root`.
 */
export async function checkSymlink(root: string, symlinkPath: string): Promise<SymlinkResolution> {
  const absoluteRoot = path.resolve(root)
  const { target, resolved } = await resolveSymlinkTarget(symlinkPath)
  return {
    symlinkPath: path.resolve(symlinkPath),
    target,
    resolved,
    insideRoot: isInsideRoot(absoluteRoot, resolved),
  }
}

/**
 * Verified that a single symlink does not escape `root`. Throws
 * `UNSAFE_SYMLINK` when it does.
 */
export async function assertSymlinkInsideRoot(
  root: string,
  symlinkPath: string,
): Promise<SymlinkResolution> {
  const check = await checkSymlink(root, symlinkPath)
  if (!check.insideRoot) {
    throw new SkillboxError(
      ErrorCode.UNSAFE_SYMLINK,
      `Symlink "${check.symlinkPath}" escapes the skill root -> ${check.resolved}`,
      { context: { path: check.symlinkPath } },
    )
  }
  return check
}

/**
 * Validates every symlink returned by a directory scan. In-root symlinks are
 * kept; any symlink resolving outside the root is rejected with
 * `UNSAFE_SYMLINK`.
 */
export async function assertSymlinksInsideRoot(
  root: string,
  symlinks: readonly ScanNode[],
): Promise<void> {
  const absoluteRoot = path.resolve(root)
  for (const node of symlinks) {
    const symlinkPath = path.join(absoluteRoot, ...node.relativePath.split('/'))
    await assertSymlinkInsideRoot(root, symlinkPath)
  }
}
