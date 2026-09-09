import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ErrorCode, SkillboxError } from '../errors.js'
import { isInsideRoot, validateRelativePath } from '../fs/paths.js'
import { readManifest, serializeManifest, type SkillboxManifest } from '../manifest/index.js'
import { serializeLockfile, type SkillboxLockfile } from '../lockfile/index.js'

export interface RepositoryValidationResult {
  manifest: SkillboxManifest
  manifestYaml: string
  lockfileYaml?: string
}

/** Read-only validation for an isolated merge tree. */
export class RepositoryValidator {
  async validate(
    repositoryRoot: string,
    lockfile?: SkillboxLockfile,
  ): Promise<RepositoryValidationResult> {
    try {
      const root = path.resolve(repositoryRoot)
      const manifest = await readManifest(root)
      for (const alias of Object.keys(manifest.skills)) {
        validateRelativePath(alias)
        const skillRoot = path.resolve(root, 'skills', alias)
        if (!isInsideRoot(path.join(root, 'skills'), skillRoot))
          throw new Error('skill escapes skills directory')
        const stat = await fs.lstat(skillRoot)
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error(`invalid skill directory: ${alias}`)
        await validateTree(skillRoot)
        const definition = path.join(skillRoot, 'SKILL.md')
        if (!(await fs.lstat(definition)).isFile()) throw new Error(`missing SKILL.md for ${alias}`)
      }
      return {
        manifest,
        manifestYaml: serializeManifest(manifest),
        ...(lockfile === undefined ? {} : { lockfileYaml: serializeLockfile(lockfile) }),
      }
    } catch (error) {
      if (error instanceof SkillboxError) throw error
      throw new SkillboxError(
        ErrorCode.SYNC_VALIDATION_FAILED,
        'The merged repository is not valid and was not activated.',
        { cause: error, recoverable: true },
      )
    }
  }
}

async function validateTree(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed: ${entry.name}`)
    if (entry.isDirectory()) await validateTree(candidate)
  }
}
