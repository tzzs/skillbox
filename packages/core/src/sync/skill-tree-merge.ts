import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { validateRelativePath } from '../fs/paths.js'
import type { SyncConflict } from './types.js'

export interface SkillTreeMergeInput {
  baseRoot: string
  localRoot: string
  remoteRoot: string
  outputRoot: string
  skillAlias: string
}
export interface SkillTreeMergeResult {
  conflicts: SyncConflict[]
  automaticallyMerged: number
}

/** Three-way file merge used only in an isolated transaction tree. */
export class SkillTreeMergeService {
  async merge(input: SkillTreeMergeInput): Promise<SkillTreeMergeResult> {
    const paths = new Set([
      ...(await files(input.baseRoot)),
      ...(await files(input.localRoot)),
      ...(await files(input.remoteRoot)),
    ])
    let automaticallyMerged = 0
    const conflicts: SyncConflict[] = []
    for (const relative of [...paths].filter((value) => value !== 'skillbox.lock').sort()) {
      validateRelativePath(relative)
      const [base, local, remote] = await Promise.all([
        read(input.baseRoot, relative),
        read(input.localRoot, relative),
        read(input.remoteRoot, relative),
      ])
      const chosen = choose(base, local, remote)
      if (chosen === undefined) {
        conflicts.push(contentConflict(input.skillAlias, relative, base, local, remote))
        continue
      }
      if (chosen !== null) {
        const target = path.join(input.outputRoot, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, chosen)
      }
      if (!same(base, local) || !same(base, remote)) automaticallyMerged++
    }
    return { conflicts, automaticallyMerged }
  }
}

async function files(root: string): Promise<string[]> {
  try {
    return await collect(root, '')
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}
async function collect(root: string, prefix: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.replaceAll('\\', '/'), entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${relative}`)
    if (entry.isDirectory()) result.push(...(await collect(root, relative)))
    else if (entry.isFile()) result.push(relative)
  }
  return result
}
async function read(root: string, relative: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(root, relative))
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}
function choose(
  base: Buffer | null,
  local: Buffer | null,
  remote: Buffer | null,
): Buffer | null | undefined {
  if (same(local, remote)) return local
  if (same(base, local)) return remote
  if (same(base, remote)) return local
  return undefined
}
function same(left: Buffer | null, right: Buffer | null): boolean {
  return left === right || (left !== null && right !== null && left.equals(right))
}
function contentConflict(
  skillAlias: string,
  file: string,
  base: Buffer | null,
  local: Buffer | null,
  remote: Buffer | null,
): SyncConflict {
  return {
    id: `${skillAlias}:content:${file}`,
    type: 'content',
    skillAlias,
    path: file,
    base: preview(base),
    local: preview(local),
    remote: preview(remote),
    allowedResolutions: ['local', 'remote', 'keep-both'],
    recommendedResolution: 'keep-both',
    destructive: false,
  }
}
function preview(value: Buffer | null): { preview: string } {
  if (value === null) return { preview: '(missing)' }
  return { preview: value.includes(0) ? '(binary file)' : value.toString('utf8').slice(0, 512) }
}
function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
