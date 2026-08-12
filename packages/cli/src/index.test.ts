import { describe, expect, it } from 'vitest'
import type { ConflictSession, RepositorySync } from '@skillbox/core'
import { main, splitVerbosityFlags, type CliDeps, ExitCode } from './index.js'

/**
 * Captures the CLI's stdout/stderr streams instead of the real process
 * streams, so tests can assert on full output without touching the console.
 */
function capture(): CliDeps & { out(): string; err(): string } {
  const chunks: string[] = []
  const errorChunks: string[] = []
  return {
    stdout: (chunk: string) => chunks.push(chunk),
    stderr: (chunk: string) => errorChunks.push(chunk),
    out: () => chunks.join(''),
    err: () => errorChunks.join(''),
  }
}

describe('cli', () => {
  it('prints the version for --version', async () => {
    const io = capture()
    const exit = await main(['--version'], io)
    expect(exit).toBe(0)
    expect(io.out()).toContain('0.1.0')
  })

  it('prints the version for -v', async () => {
    const io = capture()
    const exit = await main(['-v'], io)
    expect(exit).toBe(0)
    expect(io.out()).toContain('0.1.0')
  })

  it('prints help for --help', async () => {
    const io = capture()
    const exit = await main(['--help'], io)
    expect(exit).toBe(0)
    expect(io.out()).toContain('Usage:')
  })

  it('returns a non-zero exit code for unknown arguments', async () => {
    const io = capture()
    const exit = await main(['bogus'], io)
    expect(exit).toBe(1)
    expect(io.err()).toContain('error:')
  })

  it('lists skills in a repository with no manifest', async () => {
    const io = capture()
    const exit = await main(['list', '--json'], io)
    expect(exit).toBe(0)
    expect(io.out()).toContain('"skills"')
  })

  it('refuses the interactive mode without a TTY instead of crashing', async () => {
    const io = capture()
    const exit = await main([], { ...io, isInteractive: false })
    expect(exit).toBe(ExitCode.GENERIC)
    expect(io.err()).toContain('interactive mode')
    expect(io.out()).toBe('')
  })

  it('routes connect and disconnect through the Core RepositorySync seam', async () => {
    const io = capture()
    let disconnects = 0
    const repositorySync = {
      connect: async () => ({
        authorization: 'existing' as const,
        account: { login: 'octocat' },
        repository: {
          id: 1,
          name: 'skillbox-skills',
          owner: 'octocat',
          fullName: 'octocat/skillbox-skills',
          private: true,
          defaultBranch: 'main',
          htmlUrl: 'https://github.com/octocat/skillbox-skills',
          cloneUrl: 'https://github.com/octocat/skillbox-skills.git',
          action: 'reused' as const,
        },
        local: {
          initialized: false,
          remote: {
            name: 'origin' as const,
            url: 'https://github.com/octocat/skillbox-skills.git',
            action: 'unchanged' as const,
          },
        },
      }),
      disconnect: async () => {
        disconnects += 1
      },
      status: async () => {
        throw new Error('not used')
      },
      pull: async () => undefined,
      push: async () => undefined,
      sync: async () => ({
        kind: 'completed' as const,
        summary: { automaticallyMerged: 0, retriedPushes: 0 },
      }),
      listConflicts: async () => [],
      getConflict: async () => {
        throw new Error('not used')
      },
      resolveConflicts: async () => ({
        kind: 'blocked' as const,
        reason: 'recovery-required' as const,
        recovery: { message: 'not used', retryable: true },
      }),
      restoreSnapshot: async () => undefined,
    } satisfies RepositorySync

    expect(await main(['connect'], { ...io, repositorySync })).toBe(0)
    expect(io.out()).toContain('octocat/skillbox-skills')
    expect(await main(['disconnect'], { ...io, repositorySync })).toBe(0)
    expect(disconnects).toBe(1)
  })

  it('lists and resolves a durable conflict session across CLI invocations', async () => {
    const io = capture()
    const session: ConflictSession = {
      version: 1,
      id: 'session-1',
      repositoryId: 'repo-1',
      baseRevision: 'base',
      localRevision: 'local',
      remoteRevision: 'remote',
      snapshotId: 'snapshot-1',
      createdAt: '2026-08-13T00:00:00.000Z',
      expiresAt: '2026-08-14T00:00:00.000Z',
      conflicts: [
        {
          id: 'conflict-1',
          type: 'content',
          skillAlias: 'example',
          path: 'SKILL.md',
          allowedResolutions: ['local', 'remote', 'keep-both'],
          destructive: false,
        },
      ],
    }
    let resolutions: Record<string, string> | undefined
    const repositorySync = {
      connect: async () => {
        throw new Error('not used')
      },
      disconnect: async () => undefined,
      status: async () => {
        throw new Error('not used')
      },
      pull: async () => undefined,
      push: async () => undefined,
      sync: async () => ({
        kind: 'completed' as const,
        summary: { automaticallyMerged: 0, retriedPushes: 0 },
      }),
      listConflicts: async () => [session],
      getConflict: async (id: string) => {
        expect(id).toBe(session.id)
        return session
      },
      resolveConflicts: async (input: { resolutions: Record<string, string> }) => {
        resolutions = input.resolutions
        return {
          kind: 'completed' as const,
          summary: { automaticallyMerged: 0, retriedPushes: 0 },
        }
      },
      restoreSnapshot: async () => undefined,
    } as unknown as RepositorySync

    expect(await main(['conflicts'], { ...io, repositorySync })).toBe(0)
    expect(io.out()).toContain('example')
    expect(io.out()).toContain('conflicts resolve session-1')
    expect(
      await main(['conflicts', 'resolve', session.id, '--conflict=local'], {
        ...io,
        repositorySync,
      }),
    ).toBe(0)
    expect(resolutions).toEqual({ 'conflict-1': 'local' })
  })
})

describe('splitVerbosityFlags', () => {
  it('returns the input arguments unchanged without verbosity flags', () => {
    expect(splitVerbosityFlags(['list', '--json'])).toEqual({
      args: ['list', '--json'],
      verbosity: 'normal',
    })
  })

  it('recognises --debug as the highest verbosity', () => {
    expect(splitVerbosityFlags(['--debug', 'status'])).toEqual({
      args: ['status'],
      verbosity: 'debug',
    })
  })

  it('recognises --verbose and accepts the =true spelling', () => {
    expect(splitVerbosityFlags(['--verbose=true', 'list'])).toEqual({
      args: ['list'],
      verbosity: 'verbose',
    })
  })

  it('lets --debug win over --verbose regardless of ordering', () => {
    expect(splitVerbosityFlags(['--debug', '--verbose', 'status'])).toEqual({
      args: ['status'],
      verbosity: 'debug',
    })
    expect(splitVerbosityFlags(['--verbose', '--debug', 'status'])).toEqual({
      args: ['status'],
      verbosity: 'debug',
    })
  })

  it('keeps tokens after a literal -- verbatim', () => {
    expect(splitVerbosityFlags(['--debug', '--', '--verbose'])).toEqual({
      args: ['--', '--verbose'],
      verbosity: 'debug',
    })
  })
})
