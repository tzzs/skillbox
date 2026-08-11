import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'

export const GIT_ATTRIBUTES_FILE_NAME = '.gitattributes'

/**
 * Recommended fixture per SKILLBOX_SPEC.md: text files are stored with LF on
 * every platform, binaries are excluded from line-ending normalization. This
 * is what keeps the Canonical Skill Hash stable across Windows/macOS/Linux.
 */
export const DEFAULT_GIT_ATTRIBUTES = `* text=auto eol=lf

*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.pdf binary
*.zip binary
`

/**
 * Writes a `.gitattributes` fixture into `repositoryRoot` unless one already
 * exists. Never overwrites an existing file.
 */
export async function ensureGitAttributes(repositoryRoot: string): Promise<void> {
  const filePath = path.join(repositoryRoot, GIT_ATTRIBUTES_FILE_NAME)
  const filesystem = new FilesystemService()
  if (await filesystem.exists(filePath)) {
    return
  }
  await filesystem.writeFile(filePath, DEFAULT_GIT_ATTRIBUTES)
}
