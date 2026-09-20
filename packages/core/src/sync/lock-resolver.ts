import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { emptyLockfile, type SkillboxLockfile } from '../lockfile/index.js'
import type { SkillboxManifest } from '../manifest/index.js'

/** Rebuilds the derived lockfile after a semantic merge; lockfiles are never merged. */
export class LockResolver {
  async resolve(manifest: SkillboxManifest, repositoryRoot: string): Promise<SkillboxLockfile> {
    const lockfile = emptyLockfile()
    for (const alias of Object.keys(manifest.skills).sort()) {
      const skill = manifest.skills[alias]
      if (skill === undefined) continue
      const root = path.join(repositoryRoot, 'skills', alias)
      lockfile.skills[alias] = {
        mode: skill.mode ?? (skill.source.type === 'local' ? 'local' : 'managed'),
        source: skill.source,
        integrity: await directoryIntegrity(root),
        ...(skill.upstream === undefined
          ? {}
          : { upstream: { source: skill.upstream, baseRevision: 'merged' } }),
      }
    }
    return lockfile
  }
}

async function directoryIntegrity(root: string): Promise<string> {
  const digest = createHash('sha256')
  const files = await listFiles(root)
  for (const file of files) {
    const relative = path.relative(root, file).replaceAll('\\', '/')
    digest
      .update(relative)
      .update('\0')
      .update(await fs.readFile(file))
      .update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const candidate = path.join(root, entry.name)
    if (entry.isSymbolicLink())
      throw new Error(`Symlink is not allowed in a synced skill: ${entry.name}`)
    if (entry.isDirectory()) files.push(...(await listFiles(candidate)))
    else if (entry.isFile()) files.push(candidate)
  }
  return files.sort()
}
