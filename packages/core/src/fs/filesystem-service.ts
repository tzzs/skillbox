import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Stats, WriteFileOptions as FsWriteFileOptions } from 'node:fs'
import { toFsError } from './errors.js'

export interface ReadDirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  fullPath: string
}

export interface WriteFileOptions {
  encoding?: BufferEncoding
  mode?: number
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Thin wrapper around `node:fs/promises` that turns raw Node errors into
 * typed `SkillboxFsError`s. Keeps other Core services away from raw fs calls.
 */
export class FilesystemService {
  async exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target)
      return true
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false
      }
      throw toFsError(error, `Failed to stat "${target}"`, target)
    }
  }

  async readFile(target: string): Promise<string> {
    try {
      return await fs.readFile(target, 'utf8')
    } catch (error) {
      throw toFsError(error, `Failed to read "${target}"`, target)
    }
  }

  async writeFile(
    target: string,
    data: string | Uint8Array,
    options: WriteFileOptions = {},
  ): Promise<void> {
    try {
      const writeOptions: FsWriteFileOptions = {}
      if (options.encoding !== undefined) {
        writeOptions.encoding = options.encoding
      }
      if (options.mode !== undefined) {
        writeOptions.mode = options.mode
      }
      await fs.writeFile(target, data, writeOptions)
    } catch (error) {
      throw toFsError(error, `Failed to write "${target}"`, target)
    }
  }

  /**
   * Atomically creates a file without replacing an existing entry.
   *
   * This is the filesystem primitive used by cross-process locks. A `false`
   * result means another process (or an existing file) already owns the path;
   * all other failures remain typed filesystem errors. Keep this method public
   * and non-final so callers can provide fault-injection filesystem doubles.
   */
  async writeFileExclusive(
    target: string,
    data: string | Uint8Array,
    options: WriteFileOptions = {},
  ): Promise<boolean> {
    try {
      const writeOptions: FsWriteFileOptions = { flag: 'wx' }
      if (options.encoding !== undefined) {
        writeOptions.encoding = options.encoding
      }
      if (options.mode !== undefined) {
        writeOptions.mode = options.mode
      }
      await fs.writeFile(target, data, writeOptions)
      return true
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        return false
      }
      throw toFsError(error, `Failed to exclusively write "${target}"`, target)
    }
  }

  async mkdir(target: string, recursive = true): Promise<string | undefined> {
    try {
      return await fs.mkdir(target, { recursive })
    } catch (error) {
      throw toFsError(error, `Failed to create directory "${target}"`, target)
    }
  }

  async copy(source: string, destination: string): Promise<void> {
    try {
      await fs.cp(source, destination, { recursive: true, force: true })
    } catch (error) {
      throw toFsError(error, `Failed to copy "${source}" to "${destination}"`, destination)
    }
  }

  async move(source: string, destination: string): Promise<void> {
    try {
      await fs.rename(source, destination)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EXDEV') {
        throw toFsError(error, `Failed to move "${source}" to "${destination}"`, destination)
      }
      try {
        await this.copy(source, destination)
        await this.remove(source)
      } catch (copyError) {
        throw toFsError(
          copyError,
          `Failed to move (copy fallback) "${source}" to "${destination}"`,
          destination,
        )
      }
    }
  }

  async remove(target: string): Promise<void> {
    try {
      await fs.rm(target, { recursive: true, force: true })
    } catch (error) {
      throw toFsError(error, `Failed to remove "${target}"`, target)
    }
  }

  async readDir(target: string): Promise<ReadDirEntry[]> {
    try {
      const entries = await fs.readdir(target, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
        fullPath: path.join(target, entry.name),
      }))
    } catch (error) {
      throw toFsError(error, `Failed to read directory "${target}"`, target)
    }
  }

  async stat(target: string): Promise<Stats> {
    try {
      return await fs.stat(target)
    } catch (error) {
      throw toFsError(error, `Failed to stat "${target}"`, target)
    }
  }

  async lstat(target: string): Promise<Stats> {
    try {
      return await fs.lstat(target)
    } catch (error) {
      throw toFsError(error, `Failed to lstat "${target}"`, target)
    }
  }
}
