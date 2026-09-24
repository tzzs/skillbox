import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  acquireRuntimeLock,
  AgentRegistry,
  ClaudeAdapter,
  computeSkillIntegrity,
  FleetService,
  readLockfile,
  setGlobalVerbosity,
  SshClient,
  type FleetHostConfig,
} from '@skillbox/core'
import type { RepositorySync } from '@skillbox/core'
import type { GitHubProvider, GitProvider, SecretScanner } from './sync/index.js'
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

/** A manifest declaring one local skill whose directory is absent: one reconcile problem. */
const PROBLEM_MANIFEST =
  'version: 1\nskills:\n  ghost:\n    source:\n      type: local\n      path: skills/ghost\n'

/** A fully-stubbed `RepositorySync`; override individual methods per test. */
function repositorySyncStub(): RepositorySync {
  return {
    listSnapshots: async () => ({ snapshots: [], expired: [] }),
    connectionState: async () => ({ state: 'connected', connected: true, login: 'octocat' }),
    connect: async () => ({
      authorization: 'existing',
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
        action: 'reused',
      },
      local: {
        initialized: false,
        remote: {
          name: 'origin',
          url: 'https://github.com/octocat/skillbox-skills.git',
          action: 'unchanged',
        },
      },
    }),
    disconnect: async () => undefined,
    status: async () => {
      throw new Error('not used')
    },
    pull: async () => undefined,
    push: async () => undefined,
    sync: async () => ({
      kind: 'completed',
      summary: { automaticallyMerged: 0, retriedPushes: 0 },
    }),
    listConflicts: async () => [],
    getConflict: async () => {
      throw new Error('not used')
    },
    resolveConflicts: async () => ({
      kind: 'completed',
      summary: { automaticallyMerged: 0, retriedPushes: 0 },
    }),
    restoreSnapshot: async () => undefined,
  }
}

/** sha256 key Core derives for a repository path (`repositoryKey` is internal). */
function repositoryKeyOf(repositoryRoot: string): string {
  const absolute = path.resolve(repositoryRoot)
  const normalized = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Writes an unfinished operation journal record in exactly the shape Core
 * persists it — the state a killed process leaves behind. Deliberately raw:
 * recovery has to read durable state, not an in-memory object.
 */
async function plantInterruptedOperation(
  home: string,
  repo: string,
  operationId: string,
  kind = 'install',
): Promise<void> {
  const key = repositoryKeyOf(repo)
  const timestamp = new Date().toISOString()
  const record = {
    version: 1,
    operationId,
    repositoryKey: key,
    kind,
    owner: { id: 'cli-recovery-test', pid: process.pid },
    status: 'running',
    stage: 'mutate',
    startedAt: timestamp,
    updatedAt: timestamp,
  }
  const dir = path.join(home, 'operations', 'journals', key)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${operationId}.json`), `${JSON.stringify(record)}\n`, 'utf8')
}

/** Reads back the persisted status of one journal record. */
async function readJournalStatus(
  home: string,
  repo: string,
  operationId: string,
): Promise<string | undefined> {
  const file = path.join(
    home,
    'operations',
    'journals',
    repositoryKeyOf(repo),
    `${operationId}.json`,
  )
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { status?: string }
  return parsed.status
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
    const repositorySync: RepositorySync = {
      ...repositorySyncStub(),
      disconnect: async () => {
        disconnects += 1
      },
    }

    expect(await main(['connect'], { ...io, repositorySync })).toBe(0)
    expect(io.out()).toContain('octocat/skillbox-skills')
    expect(await main(['disconnect'], { ...io, repositorySync })).toBe(0)
    expect(disconnects).toBe(1)
  })

  it('routes `sync --multi-device` through the Core RepositorySync seam', async () => {
    const conflictsSync = {
      ...repositorySyncStub(),
      sync: async () => ({
        kind: 'conflicts' as const,
        session: {
          version: 1 as const,
          id: 'session-1',
          repositoryId: 'r1',
          baseRevision: 'a',
          localRevision: 'b',
          remoteRevision: 'c',
          snapshotId: 'snap-9',
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          conflicts: [
            {
              id: 'c1',
              type: 'content' as const,
              allowedResolutions: ['local' as const, 'remote' as const],
              destructive: true,
            },
          ],
        },
      }),
    } satisfies RepositorySync

    const io = capture()
    expect(await main(['sync', '--multi-device'], { ...io, repositorySync: conflictsSync })).toBe(0)
    expect(io.out()).toContain('1 change(s) need a decision')
    expect(io.out()).toContain('session-1')
  })

  it('rejects `sync --multi-device` up front when no RepositorySync is wired', async () => {
    // `buildContext` only skips constructing a real RepositorySync when a
    // gitProvider/githubProvider override is supplied instead — matching how
    // the legacy sync/pull/push tests simulate "not connected".
    const unimplemented = (name: string) => async () => {
      throw new Error(`gitProvider.${name} was not stubbed for this test`)
    }
    const io = capture()
    const exit = await main(['sync', '--multi-device'], {
      ...io,
      gitProvider: {
        status: unimplemented('status'),
        pull: unimplemented('pull'),
        commit: unimplemented('commit'),
        push: unimplemented('push'),
      },
    })
    expect(exit).toBe(ExitCode.GENERIC)
    expect(io.err()).toContain('GitHub')
    expect(io.err()).toContain('skillbox connect')
  })

  it('prints every reconcile problem as a detail line', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-problems-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(repo, { recursive: true })
      await fs.writeFile(path.join(repo, 'skillbox.yaml'), PROBLEM_MANIFEST)

      const io = capture()
      const exit = await main(['install'], { ...io, homeRoot: home, repositoryRoot: repo })
      expect(exit).toBe(0)
      expect(io.out()).toContain('problems 1')
      expect(io.err()).toContain('  SKILL_MISSING ghost: Local skill directory missing:')
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  /**
   * GAP §3.6 (honesty part): `enable` reconciles, and reconcile re-locks the
   * content currently on disk — so enabling a `modified` skill accepts the
   * user's edit as the new baseline. The detail line has to say that, instead
   * of only reporting that the two hashes disagree.
   */
  it('says what it did when enabling a skill absorbs a local modification', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-absorb-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      const agentDir = path.join(base, 'agent', '.claude', 'skills')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(path.join(repo, 'skills', 'demo'), { recursive: true })
      await fs.mkdir(agentDir, { recursive: true })
      const skillFile = path.join(repo, 'skills', 'demo', 'SKILL.md')
      await fs.writeFile(skillFile, '# demo v1\n')
      await fs.writeFile(
        path.join(repo, 'skillbox.yaml'),
        'version: 1\nskills:\n  demo:\n    source:\n      type: local\n      path: skills/demo\n',
      )

      const registry = new AgentRegistry([
        new ClaudeAdapter({ skillsDir: agentDir, searchPath: false }),
      ])
      const deps = (io: CliDeps & { out(): string; err(): string }): CliDeps => ({
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
        registry,
      })

      // `install` locks the content as it stands...
      expect(await main(['install'], deps(capture()))).toBe(0)
      // ...then the user edits the skill, and the next write absorbs that edit.
      await fs.writeFile(skillFile, '# demo v2 (my edit)\n')

      const io = capture()
      expect(await main(['enable', 'demo', '-a', 'claude'], deps(io))).toBe(0)
      expect(io.out()).toContain('Enabled "demo" for agent "claude"')
      expect(io.err()).toContain('  INTEGRITY_MISMATCH demo: Locked integrity sha256:')
      expect(io.err()).toContain('the locked integrity was recomputed from the repository copy')
      expect(io.err()).toContain('this local change is now the baseline')

      // The statement is not decorative: the lock really moved to the edit.
      const lock = await readLockfile(repo)
      expect(lock.skills.demo?.integrity).toBe(
        await computeSkillIntegrity(path.join(repo, 'skills', 'demo')),
      )
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('prints the sync step breakdown only above normal verbosity', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-sync-steps-'))
    const gitProvider: GitProvider = {
      status: async () => ({
        isRepository: true,
        ahead: 0,
        behind: 0,
        changedFiles: [],
        stagedFiles: [],
        conflicts: [],
      }),
      pull: async () => ({ conflicts: [], changedFiles: [] }),
      commit: async (message) => ({ committed: false, message }),
      push: async () => undefined,
    }
    const githubProvider: GitHubProvider = {
      connectionState: async () => 'connected',
      startDeviceFlow: async () => {
        throw new Error('device flow not used by this test')
      },
      pollDeviceFlow: async () => {
        throw new Error('device flow not used by this test')
      },
      disconnect: async () => undefined,
    }
    const secretScanner: SecretScanner = {
      isReady: async () => false,
      scanChangedFiles: async () => ({ findings: [], blocked: [], block: false }),
    }
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(path.join(repo, 'skills'), { recursive: true })
      await fs.writeFile(path.join(repo, 'skillbox.yaml'), 'version: 1\nskills: {}\n')
      const deps = (io: CliDeps & { out(): string; err(): string }): CliDeps => ({
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
        gitProvider,
        githubProvider,
        secretScanner,
      })

      try {
        const plain = capture()
        expect(await main(['sync'], deps(plain))).toBe(0)
        expect(plain.out()).toContain('Sync complete for')
        expect(plain.out()).not.toContain('Sync steps')
        expect(plain.err()).not.toContain('Sync steps')

        const verbose = capture()
        expect(await main(['sync', '--verbose'], deps(verbose))).toBe(0)
        // The breakdown goes to stderr so stdout stays identical to `sync`.
        expect(verbose.out()).not.toContain('Sync steps')
        expect(verbose.err()).toContain('Sync steps')
        expect(verbose.err()).toContain('secret-scan')
      } finally {
        setGlobalVerbosity('normal')
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
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

  it('lists an interrupted operation and unblocks the tool with `recover --abandon`', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-recover-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(repo, { recursive: true })
      const manifest = path.join(repo, 'skillbox.yaml')
      await fs.writeFile(manifest, 'version: 1\n', 'utf8')
      const deps = (io: CliDeps & { out(): string; err(): string }) => ({
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
      })
      await plantInterruptedOperation(home, repo, 'op-cli-crashed')

      const listIo = capture()
      expect(await main(['recover'], deps(listIo))).toBe(0)
      expect(listIo.out()).toContain('op-cli-crashed')
      expect(listIo.out()).toContain('install')
      expect(listIo.out()).toContain('skillbox recover --abandon op-cli-crashed')
      // No snapshot was captured, so undoing is honestly refused, not faked.
      expect(listIo.out()).toContain('undo its files   unavailable')
      expect(listIo.out()).not.toContain('skillbox recover --rollback op-cli-crashed')

      // `--rollback` is refused for a record that captured nothing, and says so
      // instead of rewriting files it never snapshotted.
      const rollbackIo = capture()
      expect(await main(['recover', '--rollback', 'op-cli-crashed'], deps(rollbackIo))).toBe(
        ExitCode.GENERIC,
      )
      expect(rollbackIo.err()).toContain('recorded no restore point')
      expect(rollbackIo.err()).toContain('skillbox recover --abandon op-cli-crashed')
      expect(await readJournalStatus(home, repo, 'op-cli-crashed')).toBe('running')

      const abandonIo = capture()
      expect(await main(['recover', '--abandon', 'op-cli-crashed'], deps(abandonIo))).toBe(0)
      expect(abandonIo.out()).toContain('Abandoned operation "op-cli-crashed"')
      expect(await readJournalStatus(home, repo, 'op-cli-crashed')).toBe('abandoned')
      // The interrupted operation keeps whatever it had already written.
      await expect(fs.readFile(manifest, 'utf8')).resolves.toBe('version: 1\n')

      const log = await fs.readFile(path.join(home, 'logs', 'skillbox.log'), 'utf8')
      expect(log).toContain('mutation:recover-abandon:start')
      expect(log).toContain('mutation:recover-abandon:done')

      const afterIo = capture()
      expect(await main(['recover'], deps(afterIo))).toBe(0)
      expect(afterIo.out()).toContain('No unfinished operations')

      // Deciding twice about the same record is refused, not silently accepted.
      const repeatIo = capture()
      expect(await main(['recover', '--abandon', 'op-cli-crashed'], deps(repeatIo))).toBe(
        ExitCode.GENERIC,
      )
      expect(repeatIo.err()).toContain('already abandoned')

      const unknownIo = capture()
      expect(await main(['recover', '--abandon', 'op-nope'], deps(unknownIo))).toBe(
        ExitCode.GENERIC,
      )
      expect(unknownIo.err()).toContain('skillbox recover')
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('emits the recovery decisions and the stuck state as JSON', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-recover-json-'))
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
      await plantInterruptedOperation(home, repo, 'op-cli-crashed', 'sync')

      const io = capture()
      expect(await main(['recover', '--json'], deps(io))).toBe(0)
      const body = JSON.parse(io.out()) as {
        operations: Array<Record<string, unknown> & { operationId: string }>
      }
      expect(body.operations.map((operation) => operation.operationId)).toEqual(['op-cli-crashed'])
      expect(body.operations[0]).toEqual({
        operationId: 'op-cli-crashed',
        kind: 'sync',
        status: 'running',
        stage: 'mutate',
        startedAt: expect.any(String),
        updatedAt: expect.any(String),
        scope: '(no restore point recorded)',
        backupExists: false,
        rollbackAvailable: false,
        rollbackReason: expect.stringContaining('sync'),
        abandonCommand: 'skillbox recover --abandon op-cli-crashed',
      })
      expect('rollbackCommand' in (body.operations[0] ?? {})).toBe(false)

      const actionIo = capture()
      expect(await main(['recover', '--abandon', 'op-cli-crashed', '--json'], deps(actionIo))).toBe(
        0,
      )
      expect(JSON.parse(actionIo.out())).toEqual({
        operationId: 'op-cli-crashed',
        kind: 'sync',
        status: 'abandoned',
        restoredTargets: [],
      })
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('refuses contradictory recovery flags and surfaces the stuck journal in doctor', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-recover-doctor-'))
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

      const cleanIo = capture()
      expect(await main(['doctor', '--json'], deps(cleanIo))).not.toBe(0)
      const cleanReport = JSON.parse(cleanIo.out()) as {
        probes: Array<{ name: string; ok: boolean; detail?: string }>
      }
      expect(cleanReport.probes.find((probe) => probe.name === 'operations')).toMatchObject({
        ok: true,
        detail: 'no unfinished operations',
      })

      await plantInterruptedOperation(home, repo, 'op-cli-crashed')

      const bothIo = capture()
      expect(
        await main(
          ['recover', '--abandon', 'op-cli-crashed', '--rollback', 'op-cli-crashed'],
          deps(bothIo),
        ),
      ).toBe(ExitCode.VALIDATION)
      expect(bothIo.err()).toContain('opposite decisions')

      const doctorIo = capture()
      expect(await main(['doctor'], deps(doctorIo))).not.toBe(0)
      const line = doctorIo
        .out()
        .split('\n')
        .find((row) => row.includes('operations'))
      expect(line).toContain('op-cli-crashed')
      expect(line).toContain('skillbox recover')

      const jsonIo = capture()
      expect(await main(['doctor', '--json'], deps(jsonIo))).not.toBe(0)
      const report = JSON.parse(jsonIo.out()) as {
        probes: Array<{ name: string; ok: boolean; error?: string }>
      }
      const probe = report.probes.find((item) => item.name === 'operations')
      expect(probe?.ok).toBe(false)
      expect(probe?.error).toContain('install op-cli-crashed')
      // Doctor only reports: the record is still the user's to close.
      expect(await readJournalStatus(home, repo, 'op-cli-crashed')).toBe('running')
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

  it('adds, edits, and removes hosts in .skillbox/fleet.yaml via `fleet host`', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-cli-fleet-host-'))
    try {
      const home = path.join(base, 'home')
      const repo = path.join(base, 'repo')
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(repo, { recursive: true })

      const fleet = new FleetService({ configPath: path.join(repo, '.skillbox', 'fleet.yaml') })
      const deps = (io: CliDeps & { out(): string; err(): string }) => ({
        ...io,
        homeRoot: home,
        repositoryRoot: repo,
        fleet,
      })

      const addIo = capture()
      expect(
        await main(
          ['fleet', 'host', 'add', 'web-1', '10.0.0.11', '--tag', 'prod', '--json'],
          deps(addIo),
        ),
      ).toBe(0)
      expect((JSON.parse(addIo.out()) as { host: FleetHostConfig }).host).toEqual({
        name: 'web-1',
        host: '10.0.0.11',
        tags: ['prod'],
      })

      const duplicateIo = capture()
      const duplicateExit = await main(
        ['fleet', 'host', 'add', 'web-1', '10.0.0.99'],
        deps(duplicateIo),
      )
      expect(duplicateExit).not.toBe(0)
      expect(duplicateIo.err()).toContain('web-1')

      const editIo = capture()
      expect(
        await main(
          [
            'fleet',
            'host',
            'edit',
            'web-1',
            '--rename',
            'web-1-renamed',
            '--host',
            '10.0.0.12',
            '--json',
          ],
          deps(editIo),
        ),
      ).toBe(0)
      expect((JSON.parse(editIo.out()) as { host: FleetHostConfig }).host).toMatchObject({
        name: 'web-1-renamed',
        host: '10.0.0.12',
      })

      const listIo = capture()
      await main(['fleet', 'list', '--json'], deps(listIo))
      expect(
        (JSON.parse(listIo.out()) as { hosts: FleetHostConfig[] }).hosts.map((h) => h.name),
      ).toEqual(['web-1-renamed'])

      const removeIo = capture()
      expect(
        await main(['fleet', 'host', 'remove', 'web-1-renamed', '--json'], deps(removeIo)),
      ).toBe(0)
      expect(JSON.parse(removeIo.out())).toEqual({ removed: 'web-1-renamed' })
      expect(await fleet.listHosts()).toEqual([])
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
