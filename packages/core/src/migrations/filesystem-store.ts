import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from '../fs/atomic-write.js'
import type { MigrationStore } from './types.js'

interface PersistedMigrationState {
  version: 1
  repositoryRoot: string
  completed: readonly string[]
}

export interface FilesystemMigrationStoreOptions {
  homeRoot: string
}

/**
 * Repository-keyed, durable migration checkpoints. The checkpoint filename is
 * a digest, while the resolved path remains in the document to prevent a hash
 * collision from incorrectly sharing completed migration ids.
 */
export class FilesystemMigrationStore implements MigrationStore {
  private readonly stateRoot: string

  constructor(options: FilesystemMigrationStoreOptions) {
    this.stateRoot = path.join(path.resolve(options.homeRoot), 'state', 'migrations')
  }

  async listCompleted(repositoryRoot: string): Promise<readonly string[]> {
    const state = await this.load(repositoryRoot)
    return state?.completed ?? []
  }

  async markCompleted(id: string, repositoryRoot: string): Promise<void> {
    if (id.trim().length === 0) {
      throw new Error('Migration checkpoint id cannot be empty')
    }
    const resolvedRepositoryRoot = path.resolve(repositoryRoot)
    const existing = await this.load(resolvedRepositoryRoot)
    const completed = new Set(existing?.completed ?? [])
    if (completed.has(id)) return
    completed.add(id)
    const state: PersistedMigrationState = {
      version: 1,
      repositoryRoot: resolvedRepositoryRoot,
      completed: [...completed].sort(),
    }
    await atomicWriteFile(
      this.filePath(resolvedRepositoryRoot),
      `${JSON.stringify(state, null, 2)}\n`,
    )
  }

  private filePath(repositoryRoot: string): string {
    const key = createHash('sha256').update(path.resolve(repositoryRoot)).digest('hex')
    return path.join(this.stateRoot, `${key}.json`)
  }

  private async load(repositoryRoot: string): Promise<PersistedMigrationState | undefined> {
    const resolvedRepositoryRoot = path.resolve(repositoryRoot)
    let text: string
    try {
      text = await fs.readFile(this.filePath(resolvedRepositoryRoot), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const document = JSON.parse(text) as Partial<PersistedMigrationState>
    if (
      document.version !== 1 ||
      document.repositoryRoot !== resolvedRepositoryRoot ||
      !Array.isArray(document.completed) ||
      !document.completed.every((id) => typeof id === 'string' && id.trim().length > 0)
    ) {
      throw new Error(`Invalid migration checkpoint document for "${resolvedRepositoryRoot}"`)
    }
    return { version: 1, repositoryRoot: resolvedRepositoryRoot, completed: document.completed }
  }
}
