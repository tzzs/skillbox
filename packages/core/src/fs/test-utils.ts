import { mkdtemp, mkdir, rm, symlink as rawSymlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const isWindows = process.platform === 'win32'

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'skillbox-fs-'))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir()
  try {
    return await fn(dir)
  } finally {
    await cleanup(dir)
  }
}

/** Creates a directory link (junction on Windows, symlink elsewhere). */
export async function createDirLink(target: string, link: string): Promise<void> {
  await rawSymlink(target, link, isWindows ? 'junction' : 'dir')
}

/** Whether the current platform allows creating directory links at all. */
export async function probeLinksSupported(): Promise<boolean> {
  const dir = await tempDir()
  try {
    const target = path.join(dir, 'target')
    await mkdir(target)
    await createDirLink(target, path.join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    await cleanup(dir)
  }
}

export const linksSupported = await probeLinksSupported()
