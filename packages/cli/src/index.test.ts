import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { acquireRuntimeLock, FleetService, SshClient, type FleetHostConfig } from '@skillbox/core'
import type { RepositorySync } from '@skillbox/core'
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
      sync: async () => undefined,
    } satisfies RepositorySync

    expect(await main(['connect'], { ...io, repositorySync })).toBe(0)
    expect(io.out()).toContain('octocat/skillbox-skills')
    expect(await main(['disconnect'], { ...io, repositorySync })).toBe(0)
    expect(disconnects).toBe(1)
  })

  it('migrates a legacy config.json and reports up-to-date manifest/lockfile', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-migrate-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(path.join(home, 'state'), { recursive: true })
      await fs.mkdir(repo, { recursive: true })
      await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ linkStrategy: 'copy' }))
      await fs.writeFile(path.join(repo, 'skillbox.yaml'), 'version: 1\nskills: {}\n')
      await fs.writeFile(path.join(repo, 'skillbox.lock'), 'lockfileVersion: 1\nskills: {}\n')

      const io = capture()
      const exit = await main(['migrate'], { ...io, homeRoot: home, repositoryRoot: repo })

      expect(exit).toBe(0)
      expect(io.out()).toContain('config v0 → v1 (add version field)')
      expect(io.out()).toContain('up to date')
      const persisted = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8')) as {
        version?: number
      }
      expect(persisted.version).toBe(1)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('refuses a mutation while another process holds the runtime lock', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-lock-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(repo, { recursive: true })

      const handle = await acquireRuntimeLock('mutation', { homeRoot: home })
      const io = capture()
      const exit = await main(['create', 'hello'], {
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
      })
      expect(exit).toBe(ExitCode.GENERIC)
      expect(io.err()).toContain('Another skillbox process')
      await handle.release()

      // After release the mutation succeeds.
      const second = capture()
      const retry = await main(['create', 'hello'], {
        ...second,
        homeRoot: home,
        repositoryRoot: repo,
      })
      expect(retry).toBe(0)
      expect(second.out()).toContain('Created skill "hello"')
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('lists backups and rolls back a removed skill via `skillbox rollback <id>`', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-rollback-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(repo, { recursive: true })
      const deps = (io: CliDeps & { out(): string; err(): string }) => ({
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
      })

      expect(await main(['create', 'hello'], deps(capture()))).toBe(0)
      expect(await main(['remove', 'hello', '--delete-files'], deps(capture()))).toBe(0)
      await expect(fs.stat(path.join(repo, 'skills', 'hello'))).rejects.toThrow()

      const listIo = capture()
      expect(await main(['rollback', '--json'], deps(listIo))).toBe(0)
      const body = JSON.parse(listIo.out()) as {
        backups: Array<{ id: string; operation: string; alias: string; kind: string }>
      }
      expect(
        body.backups.some((backup) => backup.operation === 'remove' && backup.alias === 'hello'),
      ).toBe(true)
      const repoDir = body.backups.find((backup) => backup.kind === 'repo-dir')
      expect(repoDir).toBeDefined()

      const rollbackIo = capture()
      expect(await main(['rollback', repoDir?.id ?? ''], deps(rollbackIo))).toBe(0)
      expect(rollbackIo.out()).toContain('Rolled back "hello"')
      await expect(
        fs.readFile(path.join(repo, 'skills', 'hello', 'SKILL.md'), 'utf8'),
      ).resolves.toContain('# hello')
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('writes structured mutation logs to the home log file', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-log-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(repo, { recursive: true })

      const io = capture()
      const exit = await main(['create', 'hello'], {
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
      })
      expect(exit).toBe(0)

      const log = await fs.readFile(path.join(home, 'logs', 'skillbox.log'), 'utf8')
      expect(log).toContain('mutation:create:start')
      expect(log).toContain('mutation:create:done')
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('runs doctor, writes a redacted debug bundle and exits non-zero on problems', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-doctor-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(repo, { recursive: true })

      // A repository without a manifest fails the manifest probe: the command
      // still prints the report and the bundle, but exits non-zero.
      const io = capture()
      const exit = await main(['doctor', '--json'], {
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
      })
      expect(exit).toBe(1)
      const report = JSON.parse(io.out()) as { probes: Array<{ name: string; ok: boolean }> }
      const manifestProbe = report.probes.find((probe) => probe.name === 'manifest')
      expect(manifestProbe?.ok).toBe(false)

      const bundlePath = path.join(base, 'bundle.json')
      const bundleIo = capture()
      const bundleExit = await main(['doctor', '--bundle', bundlePath], {
        ...bundleIo,
        homeRoot: home,
        repositoryRoot: repo,
      })
      expect(bundleExit).toBe(1)
      const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf8')) as {
        leakCheck: { findings: unknown[] }
      }
      expect(bundle.leakCheck.findings).toEqual([])
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('runs `fleet list`/`fleet install` through FleetService and exits non-zero on a host failure', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-fleet-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(path.join(repo, '.skillbox'), { recursive: true })
      await fs.writeFile(
        path.join(repo, '.skillbox', 'fleet.yaml'),
        'version: 1\nhosts:\n  - name: web-1\n    host: 10.0.0.11\n  - name: web-2\n    host: 10.0.0.12\n',
        'utf8',
      )

      const ssh = new SshClient({
        spawn: async (args) => {
          if (args[0] === '-V') {
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          const destination = args.at(-2)
          return destination === '10.0.0.11'
            ? { exitCode: 0, stdout: 'ok\n', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'boom\n' }
        },
      })
      const fleet = new FleetService({
        configPath: path.join(repo, '.skillbox', 'fleet.yaml'),
        ssh,
      })
      const deps = (io: CliDeps & { out(): string; err(): string }) => ({
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
        fleet,
      })

      const listIo = capture()
      expect(await main(['fleet', 'list', '--json'], deps(listIo))).toBe(0)
      const listed = JSON.parse(listIo.out()) as { hosts: FleetHostConfig[] }
      expect(listed.hosts.map((host) => host.name)).toEqual(['web-1', 'web-2'])

      const installIo = capture()
      const exit = await main(['fleet', 'install', '--json'], deps(installIo))
      expect(exit).toBe(1)
      const result = JSON.parse(installIo.out()) as {
        results: Array<{ host: string; ok: boolean }>
      }
      expect(result.results.find((entry) => entry.host === 'web-1')?.ok).toBe(true)
      expect(result.results.find((entry) => entry.host === 'web-2')?.ok).toBe(false)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('selects fleet hosts ad-hoc via --ssh without needing fleet.yaml', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-fleet-adhoc-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(repo, { recursive: true })

      const ssh = new SshClient({
        spawn: async (args) =>
          args[0] === '-V'
            ? { exitCode: 0, stdout: '', stderr: '' }
            : { exitCode: 0, stdout: 'status ok\n', stderr: '' },
      })
      const fleet = new FleetService({
        configPath: path.join(repo, '.skillbox', 'fleet.yaml'),
        ssh,
      })

      const io = capture()
      const exit = await main(['fleet', 'status', '--ssh', 'deploy@10.0.0.9', '--json'], {
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
        fleet,
      })
      expect(exit).toBe(0)
      const result = JSON.parse(io.out()) as { results: Array<{ host: string; ok: boolean }> }
      expect(result.results).toEqual([
        {
          host: 'deploy@10.0.0.9',
          ok: true,
          exitCode: 0,
          stdout: 'status ok\n',
          stderr: '',
          durationMs: expect.any(Number),
        },
      ])
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
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
