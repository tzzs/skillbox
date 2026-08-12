import { describe, expect, it } from 'vitest'
import { main, type CliDeps } from '../index.js'
import { createDefaultMigrationProvider } from './loaders.js'
import type { MigrationInput, MigrationProvider } from './types.js'

class FakeMigrationProvider implements MigrationProvider {
  calls: MigrationInput[] = []

  async migrate(input: MigrationInput) {
    this.calls.push(input)
    return { applied: ['manifest-v1'], skipped: ['lockfile-v1'] }
  }
}

function capture(): { deps: CliDeps; out: () => string; err: () => string } {
  let stdout = ''
  let stderr = ''
  return {
    deps: {
      repositoryRoot: '/repo',
      homeRoot: '/home/.skillbox',
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      },
    },
    out: () => stdout,
    err: () => stderr,
  }
}

describe('skillbox migrate', () => {
  it('runs Core migrations against the current repository and summarizes applied/skipped checkpoints', async () => {
    const io = capture()
    const migrationProvider = new FakeMigrationProvider()

    const exit = await main(['migrate'], { ...io.deps, migrationProvider })

    expect(exit).toBe(0)
    expect(migrationProvider.calls).toEqual([
      { repositoryRoot: '/repo', homeRoot: '/home/.skillbox' },
    ])
    expect(io.out()).toContain('Migration complete')
    expect(io.out()).toContain('Applied: manifest-v1')
    expect(io.out()).toContain('Already current: lockfile-v1')
    expect(io.err()).toBe('')
  })

  it('renders the unmodified migration result with --json', async () => {
    const io = capture()
    const migrationProvider = new FakeMigrationProvider()

    const exit = await main(['migrate', '--json'], { ...io.deps, migrationProvider })

    expect(exit).toBe(0)
    expect(JSON.parse(io.out())).toEqual({
      applied: ['manifest-v1'],
      skipped: ['lockfile-v1'],
    })
  })

  it('adapts a MigrationRegistry and FilesystemMigrationStore from Core', async () => {
    const calls: unknown[] = []
    class Registry {
      async run(input: unknown) {
        calls.push(input)
        return { applied: ['runtime-config-v1'], skipped: [] }
      }
    }
    class Store {
      constructor(readonly options: unknown) {}
    }
    const provider = createDefaultMigrationProvider(async () => ({
      MigrationRegistry: Registry,
      FilesystemMigrationStore: Store,
    }))

    await expect(provider.migrate({ repositoryRoot: '/repo', homeRoot: '/home' })).resolves.toEqual(
      {
        applied: ['runtime-config-v1'],
        skipped: [],
      },
    )
    expect(calls).toEqual([{ repositoryRoot: '/repo', store: expect.any(Store) }])
  })
})
