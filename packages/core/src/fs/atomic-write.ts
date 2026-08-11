import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { toFsError } from './errors.js'

export interface AtomicWriteFs {
  writeFile(target: string, data: string | Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(target: string, options: { force: boolean }): Promise<void>
  mkdir(target: string, options: { recursive: boolean }): Promise<string | undefined>
}

export const defaultAtomicWriteFs: AtomicWriteFs = {
  writeFile: (target, data) => fs.writeFile(target, data),
  rename: (from, to) => fs.rename(from, to),
  rm: (target, options) => fs.rm(target, options),
  mkdir: (target, options) => fs.mkdir(target, options),
}

export interface AtomicWriteOptions {
  fs?: Partial<AtomicWriteFs>
  /**
   * Overrides where the temporary file lives. Must stay in the same directory
   * as the target so that the final `rename` is atomic. Used for fault
   * injection in tests.
   */
  tempPath?: (target: string) => string
}

function defaultTempPath(target: string): string {
  const directory = path.dirname(target)
  const base = path.basename(target)
  return path.join(directory, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
}

/**
 * Atomically replaces `target` with `data` by writing a temp file in the same
 * directory and then renaming it over the target. If anything fails mid-way
 * (temp write, rename), the previous target file is left untouched and any
 * leftover temp file is removed.
 */
export async function atomicWriteFile(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const impl: AtomicWriteFs = { ...defaultAtomicWriteFs, ...options.fs }
  const tempPath =
    options.tempPath !== undefined ? options.tempPath(target) : defaultTempPath(target)

  try {
    await impl.mkdir(path.dirname(target), { recursive: true })
    await impl.writeFile(tempPath, data)
    await impl.rename(tempPath, target)
  } catch (error) {
    await impl.rm(tempPath, { force: true }).catch(() => {})
    throw toFsError(error, `Atomic write to "${target}" failed`, target)
  }
}
