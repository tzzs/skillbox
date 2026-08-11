import * as path from 'node:path'
import { SkillboxError, ErrorCode } from './errors.js'
import { validateRelativePath } from './paths.js'
import { scanSkillDirectory, type SkillDirectoryScan } from './scanner.js'
import { assertSymlinksInsideRoot } from './symlinks.js'

export interface SkillValidationResult {
  root: string
  /** Absolute path to the detected SKILL.md file. */
  skillMdPath: string
  scan: SkillDirectoryScan
}

/**
 * Validates that `root` is a safe, importable Skill directory:
 * - SKILL.md must exist
 * - no path traversal anywhere in the tree
 * - no "special" files (FIFO, sockets, devices, ...)
 * - no symlink that resolves outside of the Skill root
 *
 * Throws a typed `SkillboxFsError` with code `INVALID_SKILL` (or
 * `UNSAFE_SYMLINK`) when the directory is not a valid Skill.
 */
export async function validateSkillDirectory(root: string): Promise<SkillValidationResult> {
  const absolute = path.resolve(root)
  const scan = await scanSkillDirectory(absolute)

  for (const node of scan.nodes) {
    try {
      validateRelativePath(node.relativePath)
    } catch {
      throw new SkillboxError(
        ErrorCode.INVALID_SKILL,
        `Skill contains an unsafe path: "${node.relativePath}"`,
        { context: { path: absolute } },
      )
    }
    if (node.kind === 'special') {
      throw new SkillboxError(
        ErrorCode.INVALID_SKILL,
        `Skill contains an unsafe special file: "${node.relativePath}"`,
        { context: { path: absolute } },
      )
    }
  }

  await assertSymlinksInsideRoot(absolute, scan.symlinks)

  const skillMd = scan.files.find((file) => file.toLowerCase() === 'skill.md')
  if (skillMd === undefined) {
    throw new SkillboxError(ErrorCode.INVALID_SKILL, 'SKILL.md is missing', {
      context: { path: absolute },
    })
  }

  return {
    root: absolute,
    skillMdPath: path.join(absolute, ...skillMd.split('/')),
    scan,
  }
}
