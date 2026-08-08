import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Stats } from 'node:fs'
import { toFsError } from './errors.js'

export type LinkStrategy = 'auto' | 'symlink' | 'junction' | 'copy'

export type ResolvedLinkStrategy = Exclude<LinkStrategy, 'auto'>

export type SymlinkType = 'file' | 'dir' | 'junction'

export interface LinkFsBundle {
  symlink(target: string, linkPath: string, type: SymlinkType): Promise<void>
  copy(
    source: string,
    destination: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>
  stat(target: string): Promise<Stats>
}

export const defaultLinkFs: LinkFsBundle = {
  symlink: (target, linkPath, type) => fs.symlink(target, linkPath, type),
  copy: (source, destination) => fs.cp(source, destination, { recursive: true, force: false }),
  stat: (target) => fs.stat(target),
}

const WINDOWS_JUNCTION_TARGET = 'junction'

/**
 * Picks the concrete link strategy for a platform.
 *
 * - auto: Windows -> junction, macOS/Linux -> symlink
 * - explicit symlink / junction / copy pass through unchanged
 * - on Windows a forced `symlink` of a directory still maps to a junction so
 *   that no administrator privileges are required
 */
export function resolveLinkStrategy(
  strategy: LinkStrategy,
  platform: NodeJS.Platform = process.platform,
): ResolvedLinkStrategy {
  if (strategy !== 'auto') {
    return strategy
  }
  return platform === 'win32' ? 'junction' : 'symlink'
}

export interface CreateLinkOptions {
  strategy?: LinkStrategy
  platform?: NodeJS.Platform
  deps?: Partial<LinkFsBundle>
}

export interface CreateLinkResult {
  strategy: ResolvedLinkStrategy
  /** True when the primary strategy failed and a `copy` fallback was used. */
  usedFallback: boolean
}

async function isDirectory(target: string, statsImpl: LinkFsBundle['stat']): Promise<boolean> {
  try {
    return (await statsImpl(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Creates a link from `destination` to `target`.
 *
 * `auto` selects the platform default. If the chosen link type cannot be
 * created (`symlink`/`junction` are not supported or lack privileges), it falls
 * back to a full directory `copy`.
 */
export async function createLink(
  source: string,
  destination: string,
  options: CreateLinkOptions = {},
): Promise<CreateLinkResult> {
  const platform = options.platform ?? process.platform
  const deps: LinkFsBundle = { ...defaultLinkFs, ...options.deps }
  const strategy = resolveLinkStrategy(options.strategy ?? 'auto', platform)
  const isWindows = platform === 'win32'

  const apply = async (kind: ResolvedLinkStrategy): Promise<void> => {
    if (kind === 'copy') {
      await deps.copy(source, destination, { recursive: true, force: false })
      return
    }
    if (kind === 'junction') {
      await deps.symlink(path.resolve(source), destination, WINDOWS_JUNCTION_TARGET)
      return
    }
    const asDirectory = platform !== 'win32' ? await isDirectory(source, deps.stat) : isWindows
    const type: SymlinkType = asDirectory ? (isWindows ? 'junction' : 'dir') : 'file'
    await deps.symlink(source, destination, type)
  }

  try {
    await apply(strategy)
    return { strategy, usedFallback: false }
  } catch (error) {
    if (strategy === 'copy') {
      throw toFsError(error, `Failed to copy "${source}" to "${destination}"`, destination)
    }
    try {
      await apply('copy')
      return { strategy, usedFallback: true }
    } catch (fallbackError) {
      throw toFsError(
        fallbackError,
        `Failed to link "${source}" to "${destination}" (fallback to copy)`,
        destination,
      )
    }
  }
}
