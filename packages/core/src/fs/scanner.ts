import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import { FsIoErrorCode, toFsError, SkillboxFsError } from './errors.js'

export type ScanNodeKind = 'file' | 'directory' | 'symlink' | 'special'

export interface ScanNode {
  /** Relative path from the scanned root, always forward slashes. */
  relativePath: string
  kind: ScanNodeKind
  /** Size in bytes from `lstat`. */
  size: number
  /** For `symlink` nodes, the raw target reported by `readlink`. */
  symlinkTarget?: string
}

export interface SkillDirectoryScan {
  root: string
  nodes: ScanNode[]
  files: string[]
  directories: string[]
  symlinks: ScanNode[]
  totalSize: number
}

function describeEntryKind(entry: Dirent): ScanNodeKind {
  if (entry.isSymbolicLink()) {
    return 'symlink'
  }
  if (entry.isDirectory()) {
    return 'directory'
  }
  if (entry.isFile()) {
    return 'file'
  }
  return 'special'
}

function toPortableRelative(root: string, fullPath: string): string {
  const relative = path.relative(root, fullPath)
  const parts = relative.split(path.sep).filter((part) => part !== '')
  return parts.join('/')
}

async function collect(root: string, currentDir: string, nodes: ScanNode[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true })
  } catch (error) {
    throw toFsError(error, `Failed to read directory "${currentDir}"`, currentDir)
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name)
    const kind = describeEntryKind(entry)

    let size = 0
    let symlinkTarget: string | undefined
    if (kind !== 'directory') {
      try {
        const stats = await fs.lstat(fullPath)
        size = stats.size
        if (kind === 'symlink') {
          symlinkTarget = await fs.readlink(fullPath)
        }
      } catch (error) {
        throw toFsError(error, `Failed to inspect "${fullPath}"`, fullPath)
      }
    }

    const node: ScanNode = {
      relativePath: toPortableRelative(root, fullPath),
      kind,
      size,
    }
    if (symlinkTarget !== undefined) {
      node.symlinkTarget = symlinkTarget
    }
    nodes.push(node)

    if (kind === 'directory') {
      await collect(root, fullPath, nodes)
    }
  }
}

/** Recursive scan of a skill directory, never following symlinks. */
export function scanSkillDirectory(root: string): Promise<SkillDirectoryScan> {
  return scanDirectory(root)
}

export async function scanDirectory(root: string): Promise<SkillDirectoryScan> {
  const absolute = path.resolve(root)
  let rootStats: Stats
  try {
    rootStats = await fs.stat(absolute)
  } catch (error) {
    throw toFsError(error, `Cannot scan "${absolute}"`, absolute)
  }
  if (!rootStats.isDirectory()) {
    throw new SkillboxFsError(FsIoErrorCode.IO_ERROR, `"${absolute}" is not a directory`, {
      path: absolute,
    })
  }

  const nodes: ScanNode[] = []
  await collect(absolute, absolute, nodes)

  const files: string[] = []
  const directories: string[] = []
  const symlinks: ScanNode[] = []
  let totalSize = 0
  for (const node of nodes) {
    if (node.kind === 'file') {
      files.push(node.relativePath)
      totalSize += node.size
    } else if (node.kind === 'directory') {
      directories.push(node.relativePath)
    } else if (node.kind === 'symlink') {
      symlinks.push(node)
    }
  }

  return { root: absolute, nodes, files, directories, symlinks, totalSize }
}
