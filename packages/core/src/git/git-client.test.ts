import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { GitClient } from './git-client.js'
import { ErrorCode, isSkillboxError } from '../errors.js'
import { buildGitAuthEnvironment } from '../github/credential-bridge.js'
import { tempDir, withTempDir } from '../fs/test-utils.js'
import type { GitExecResult, GitSpawn, GitTransportAuth } from './git-client.js'

interface GitConfig {
  client: GitClient
  root: string
}

/**
 * Creates a git repository and configures its committer identity so `commit`
 * works without a global gitconfig (CI/headless safe).
 */
async function seedRepo(dir: string): Promise<GitConfig> {
  await fs.mkdir(dir, { recursive: true })
  await rawGit(dir, ['init', '--initial-branch=main'])
  await rawGit(dir, ['config', 'user.email', 'skillbox-test@example.com'])
  await rawGit(dir, ['config', 'user.name', 'Skillbox Test'])
  return { client: new GitClient(), root: dir }
}

/** Runs `git` directly for fixture setup (identity, commits, remotes). */
function rawGit(cwd: string, args: string[]): Promise<GitExecResult> {
  return new Promise<GitExecResult>((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))
        return
      }
      resolve({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

async function writeFile(dir: string, name: string, content: string): Promise<string> {
  const target = path.join(dir, name)
  await fs.writeFile(target, content, 'utf8')
  return target
}

describe('GitClient', () => {
  it('injects transport auth for one push without placing the token in argv', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    const spawn: GitSpawn = async (args, options) => {
      calls.push({ args, ...(options.env === undefined ? {} : { env: options.env }) })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const client = new GitClient({ spawn })
    const auth: GitTransportAuth = {
      prefixArgs: ['-c', 'credential.helper=!helper'],
      env: { SKILLBOX_GITHUB_ACCESS_TOKEN: 'top-secret' },
      sensitiveEnvKeys: ['SKILLBOX_GITHUB_ACCESS_TOKEN'],
    }

    await client.push('/repo', { remote: 'origin', branch: 'main', auth })
    await client.gitVersion('/repo')

    expect(calls[0]?.args).toEqual(['-c', 'credential.helper=!helper', 'push', 'origin', 'main'])
    expect(calls[0]?.args.join(' ')).not.toContain('top-secret')
    expect(calls[0]?.env?.SKILLBOX_GITHUB_ACCESS_TOKEN).toBe('top-secret')
    expect(calls[1]?.args).toEqual(['--version'])
    expect(calls[1]?.env).toBeUndefined()
  })

  it('redacts transport credentials from Git errors', async () => {
    const token = 'token-that-must-not-leak'
    const spawn: GitSpawn = async () => ({ exitCode: 1, stdout: '', stderr: `rejected ${token}` })
    const client = new GitClient({ spawn })
    const auth: GitTransportAuth = {
      prefixArgs: [],
      env: { SKILLBOX_GITHUB_ACCESS_TOKEN: token },
      sensitiveEnvKeys: ['SKILLBOX_GITHUB_ACCESS_TOKEN'],
    }

    const error = await client.push('/repo', { auth }).catch((caught: unknown) => caught)
    expect(JSON.stringify(error)).not.toContain(token)
    expect((error as Error).message).not.toContain(token)
    expect(error).toMatchObject({ context: { stderr: 'rejected [REDACTED]' } })
  })

  it.each([
    ['non-fast-forward update rejected', ErrorCode.GIT_PUSH_REJECTED],
    ['fatal: Authentication failed for remote', ErrorCode.GIT_AUTH_FAILED],
  ])('maps push failure "%s" to a stable error', async (stderr, code) => {
    const spawn: GitSpawn = async () => ({ exitCode: 1, stdout: '', stderr })
    const client = new GitClient({ spawn })
    const error = await client.push('/repo').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code, recoverable: true })
  })

  it('reports the installed git version', async () => {
    const root = await tempDir()
    const { client } = await seedRepo(root)
    const version = await client.gitVersion(root)
    expect(version).toMatch(/^git version \d/)
  })

  it('init creates a git repository', async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, 'repo')
      await fs.mkdir(root)
      const client = new GitClient()
      await client.init(root)
      const entries = await fs.readdir(path.join(root, '.git'), { withFileTypes: true })
      expect(entries.length).toBeGreaterThan(0)
      const status = await client.status(root)
      expect(status.repositoryRoot).toBe(root)
    })
  })

  it('status parses untracked, staged and unstaged files from porcelain v1', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))

      await writeFile(root, 'tracked.txt', 'one')
      await rawGit(root, ['add', 'tracked.txt'])
      await rawGit(root, ['commit', '-m', 'add tracked'])
      expect((await client.status(root)).clean).toBe(true)

      await writeFile(root, 'untracked.txt', 'nope')
      const untracked = await client.status(root)
      expect(untracked.untracked.map((f) => f.path)).toEqual(['untracked.txt'])

      await writeFile(root, 'tracked.txt', 'two')
      const dirty = await client.status(root)
      expect(dirty.clean).toBe(false)
      expect(dirty.unstaged.map((f) => f.path)).toEqual(['tracked.txt'])
      expect(dirty.files[0]).toMatchObject({ xy: ' M', path: 'tracked.txt', unstaged: true })
    })
  })

  it('commit records the message and returns the HEAD hash', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      await writeFile(root, 'a.txt', 'a')
      await rawGit(root, ['add', 'a.txt'])
      const commit = await client.commit(root, 'initial')
      expect(commit.hash).toMatch(/^[0-9a-f]{40}$/)
      const log = await rawGit(root, ['log', '--format=%s', '-1'])
      expect(log.stdout.trim()).toBe('initial')
    })
  })

  it('commit with a files list only includes those paths', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      await writeFile(root, 'keep.txt', 'keep')
      await writeFile(root, 'skip.txt', 'skip')
      await rawGit(root, ['add', 'keep.txt', 'skip.txt'])

      await client.commit(root, 'only keep', ['keep.txt'])

      const committed = await rawGit(root, ['show', '--name-only', '--format=', 'HEAD'])
      expect(committed.stdout).toContain('keep.txt')
      expect(committed.stdout).not.toContain('skip.txt')
      // skip.txt stays staged, keep.txt is committed
      const status = await client.status(root)
      expect(status.staged.map((f) => f.path)).toEqual(['skip.txt'])
    })
  })

  it('commit stages a new managed path without staging unrelated untracked files', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      await writeFile(root, 'skillbox.yaml', 'version: 1')
      await writeFile(root, 'notes.txt', 'personal')

      await client.commit(root, 'managed only', ['skillbox.yaml'])

      const committed = await rawGit(root, ['show', '--name-only', '--format=', 'HEAD'])
      expect(committed.stdout).toContain('skillbox.yaml')
      expect(committed.stdout).not.toContain('notes.txt')
      expect((await client.status(root)).untracked.map((file) => file.path)).toEqual(['notes.txt'])
    })
  })

  it('adds, reads and removes a named remote idempotently', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      const bare = path.join(dir, 'remote.git')
      await rawGit(dir, ['init', '--bare', bare])

      expect(await client.getRemote(root, 'origin')).toBeUndefined()
      await client.addRemote(root, 'origin', bare)
      expect(await client.getRemote(root, 'origin')).toEqual({ name: 'origin', url: bare })
      await client.removeRemote(root, 'origin')
      expect(await client.getRemote(root, 'origin')).toBeUndefined()
    })
  })

  it('sets the upstream on the first push', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      const bare = path.join(dir, 'remote.git')
      await rawGit(dir, ['init', '--bare', '--initial-branch=main', bare])
      await writeFile(root, 'skillbox.yaml', 'version: 1')
      await client.commit(root, 'seed', ['skillbox.yaml'])
      await client.addRemote(root, 'origin', bare)

      await client.push(root, { remote: 'origin', branch: 'main', setUpstream: true })

      expect((await client.status(root)).upstream).toBe('origin/main')
    })
  })

  it('prevents repository hooks from reading transport credentials', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      const bare = path.join(dir, 'remote.git')
      const marker = path.join(dir, 'hook-ran.txt')
      await rawGit(dir, ['init', '--bare', '--initial-branch=main', bare])
      await writeFile(root, 'skillbox.yaml', 'version: 1')
      await client.commit(root, 'seed', ['skillbox.yaml'])
      await client.addRemote(root, 'origin', bare)
      const hook = path.join(root, '.git', 'hooks', 'pre-push')
      await fs.writeFile(
        hook,
        '#!/bin/sh\nprintf "%s" "$SKILLBOX_GITHUB_ACCESS_TOKEN" > "$SKILLBOX_HOOK_MARKER"\n',
        'utf8',
      )
      await fs.chmod(hook, 0o755)
      const baseAuth = buildGitAuthEnvironment('hook-secret')
      const auth: GitTransportAuth = {
        ...baseAuth,
        env: { ...baseAuth.env, SKILLBOX_HOOK_MARKER: marker },
      }

      await client.push(root, { remote: 'origin', branch: 'main', auth })

      await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('diff reports changes between two refs and in the worktree', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      await writeFile(root, 'file.txt', 'one')
      await rawGit(root, ['add', 'file.txt'])
      const first = await client.commit(root, 'one')
      await writeFile(root, 'file.txt', 'two')
      await rawGit(root, ['add', 'file.txt'])
      const second = await client.commit(root, 'two')

      const between = await client.diff(root, first.hash, second.hash)
      expect(between).toEqual({ files: [{ status: 'M', path: 'file.txt' }] })

      await writeFile(root, 'file.txt', 'three')
      const working = await client.diff(root)
      expect(working.files).toEqual([{ status: 'M', path: 'file.txt' }])
    })
  })

  it('clone, push and pull sync between a bare remote and working clones', async () => {
    await withTempDir(async (dir) => {
      const client = new GitClient()
      const bare = path.join(dir, 'remote.git')
      await rawGit(dir, ['init', '--bare', '--initial-branch=main', bare])

      const work = await seedRepo(path.join(dir, 'work'))
      await writeFile(work.root, 'skill.md', '# skill')
      await rawGit(work.root, ['add', 'skill.md'])
      await work.client.commit(work.root, 'seed')
      await rawGit(work.root, ['remote', 'add', 'origin', bare])
      await work.client.push(work.root, { branch: 'main' })

      const cloneDir = path.join(dir, 'clone')
      await client.clone(bare, cloneDir, { ref: 'main' })
      // clones carry no local identity; configure one so the second-device
      // commit works without a global gitconfig (CI/headless safe)
      await rawGit(cloneDir, ['config', 'user.email', 'skillbox-test@example.com'])
      await rawGit(cloneDir, ['config', 'user.name', 'Skillbox Test'])
      const cloned = await rawGit(cloneDir, ['ls-tree', '--name-only', 'HEAD'])
      expect(cloned.stdout).toContain('skill.md')

      // second device pushes, first pulls
      await writeFile(path.join(dir, 'clone'), 'extra.txt', 'extra')
      await rawGit(cloneDir, ['add', 'extra.txt'])
      await rawGit(cloneDir, ['commit', '-m', 'extra'])
      await client.push(cloneDir, { branch: 'main' })

      await work.client.pull(work.root, { remote: 'origin', branch: 'main' })
      const pulled = await rawGit(work.root, ['ls-tree', '--name-only', 'HEAD'])
      expect(pulled.stdout).toContain('extra.txt')
    })
  }, 30000)

  it('status reports the tracked remote and real ahead/behind counts', async () => {
    await withTempDir(async (dir) => {
      const bare = path.join(dir, 'remote.git')
      await rawGit(dir, ['init', '--bare', '--initial-branch=main', bare])

      const local = await seedRepo(path.join(dir, 'local'))
      await writeFile(local.root, 'base.txt', 'base')
      await rawGit(local.root, ['add', 'base.txt'])
      await local.client.commit(local.root, 'base')
      await rawGit(local.root, ['remote', 'add', 'origin', bare])
      await rawGit(local.root, ['push', '-u', 'origin', 'main'])

      const peerRoot = path.join(dir, 'peer')
      await local.client.clone(bare, peerRoot, { ref: 'main' })
      await rawGit(peerRoot, ['config', 'user.email', 'skillbox-test@example.com'])
      await rawGit(peerRoot, ['config', 'user.name', 'Skillbox Test'])
      await writeFile(peerRoot, 'remote.txt', 'remote')
      await rawGit(peerRoot, ['add', 'remote.txt'])
      await rawGit(peerRoot, ['commit', '-m', 'remote advance'])
      await rawGit(peerRoot, ['push', 'origin', 'main'])

      await writeFile(local.root, 'local.txt', 'local')
      await rawGit(local.root, ['add', 'local.txt'])
      await local.client.commit(local.root, 'local advance')
      await local.client.fetch(local.root)

      const status = await local.client.status(local.root)
      expect(status).toMatchObject({
        branch: 'main',
        remote: { name: 'origin', url: bare },
        ahead: 1,
        behind: 1,
      })
    })
  }, 20000)

  it('status still reports origin when the branch has no upstream', async () => {
    await withTempDir(async (dir) => {
      const bare = path.join(dir, 'remote.git')
      await rawGit(dir, ['init', '--bare', '--initial-branch=main', bare])
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      await writeFile(root, 'skill.md', '# local')
      await rawGit(root, ['add', 'skill.md'])
      await client.commit(root, 'local only')
      await rawGit(root, ['remote', 'add', 'origin', bare])

      const status = await client.status(root)
      expect(status).toMatchObject({
        branch: 'main',
        remote: { name: 'origin', url: bare },
        ahead: 0,
        behind: 0,
      })
      expect(status.upstream).toBeUndefined()
    })
  })

  it('status omits remote details when the repository has no remotes', async () => {
    await withTempDir(async (dir) => {
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      await writeFile(root, 'skill.md', '# local')
      await rawGit(root, ['add', 'skill.md'])
      await client.commit(root, 'local only')

      const status = await client.status(root)
      expect(status).toMatchObject({ branch: 'main', ahead: 0, behind: 0 })
      expect(status.upstream).toBeUndefined()
      expect(status.remote).toBeUndefined()
    })
  })

  it('status keeps the configured remote for a detached HEAD', async () => {
    await withTempDir(async (dir) => {
      const bare = path.join(dir, 'remote.git')
      await rawGit(dir, ['init', '--bare', '--initial-branch=main', bare])
      const { client, root } = await seedRepo(path.join(dir, 'repo'))
      await writeFile(root, 'skill.md', '# tracked')
      await rawGit(root, ['add', 'skill.md'])
      await client.commit(root, 'tracked')
      await rawGit(root, ['remote', 'add', 'origin', bare])
      await rawGit(root, ['push', '-u', 'origin', 'main'])
      await rawGit(root, ['checkout', '--detach', 'HEAD'])

      const status = await client.status(root)
      expect(status).toMatchObject({
        remote: { name: 'origin', url: bare },
        ahead: 0,
        behind: 0,
        clean: true,
      })
      expect(status.branch).toBeUndefined()
      expect(status.upstream).toBeUndefined()
    })
  })

  it('materialize clones when absent and pulls when present', async () => {
    await withTempDir(async (dir) => {
      const bare = path.join(dir, 'remote.git')
      await rawGit(dir, ['init', '--bare', '--initial-branch=main', bare])
      const work = await seedRepo(path.join(dir, 'work'))
      await writeFile(work.root, 'skill.md', '# v1')
      await rawGit(work.root, ['add', 'skill.md'])
      await work.client.commit(work.root, 'v1')
      await rawGit(work.root, ['remote', 'add', 'origin', bare])
      await work.client.push(work.root, { branch: 'main' })

      const client = new GitClient()
      const target = path.join(dir, 'mirror')

      const first = await client.materialize({ url: bare, targetDir: target, ref: 'main' })
      expect(first.cloned).toBe(true)
      expect(first.headRev).toMatch(/^[0-9a-f]{40}$/)

      // remote advances; second materialize must fetch + ff
      await writeFile(work.root, 'skill.md', '# v2')
      await rawGit(work.root, ['add', 'skill.md'])
      await work.client.commit(work.root, 'v2')
      await work.client.push(work.root, { branch: 'main' })

      const second = await client.materialize({ url: bare, targetDir: target, ref: 'main' })
      expect(second.cloned).toBe(false)
      const content = await fs.readFile(path.join(target, 'skill.md'), 'utf8')
      expect(content).toBe('# v2')
    })
  }, 20000)

  it('surfaces conflicts after a divergent pull via status', async () => {
    await withTempDir(async (dir) => {
      const bare = path.join(dir, 'remote.git')
      await rawGit(dir, ['init', '--bare', '--initial-branch=main', bare])

      const seed = await seedRepo(path.join(dir, 'seed'))
      await writeFile(seed.root, 'same.txt', 'base')
      await rawGit(seed.root, ['add', 'same.txt'])
      await seed.client.commit(seed.root, 'base')
      await rawGit(seed.root, ['remote', 'add', 'origin', bare])
      await seed.client.push(seed.root, { branch: 'main' })

      const a = await seedRepo(path.join(dir, 'a'))
      const b = await seedRepo(path.join(dir, 'b'))
      for (const repo of [a, b]) {
        await rawGit(repo.root, ['remote', 'add', 'origin', bare])
        // modern git refuses divergent pulls unless told to merge; the test
        // asserts the merge-conflict path, so pin the merge semantics
        await rawGit(repo.root, ['config', 'pull.rebase', 'false'])
        await repo.client.pull(repo.root, { remote: 'origin', branch: 'main' })
      }

      // both edit the same file, A pushes first
      await writeFile(a.root, 'same.txt', 'from A')
      await rawGit(a.root, ['add', 'same.txt'])
      await a.client.commit(a.root, 'a wins')
      await a.client.push(a.root, { branch: 'main' })

      await writeFile(b.root, 'same.txt', 'from B')
      await rawGit(b.root, ['add', 'same.txt'])
      await b.client.commit(b.root, 'b diverges')

      // B pulls A's change → conflict → non-zero exit → GIT_COMMAND_FAILED
      let caught: unknown
      try {
        await b.client.pull(b.root, { remote: 'origin', branch: 'main' })
      } catch (error) {
        caught = error
      }
      expect(isSkillboxError(caught)).toBe(true)
      if (isSkillboxError(caught)) {
        expect(caught.code).toBe(ErrorCode.GIT_COMMAND_FAILED)
        expect(caught.context).toMatchObject({ exitCode: 1 })
      }
      expect(isSkillboxError(caught) && caught.context?.stderr).toBeTruthy()

      const status = await b.client.status(b.root)
      expect(status.hasConflicts).toBe(true)
      expect(status.conflicts.map((f) => f.path)).toEqual(['same.txt'])
      expect(status.conflicts[0]?.conflict).toBe(true)
    })
  }, 20000)

  it('throws GIT_NOT_FOUND when git is not on PATH (injected spawn)', async () => {
    const notFound = new Error('spawn git ENOENT')
    ;(notFound as NodeJS.ErrnoException).code = 'ENOENT'
    const client = new GitClient({
      spawn: async () => {
        throw notFound
      },
    })
    let caught: unknown
    try {
      await client.status('/some/repo')
    } catch (error) {
      caught = error
    }
    expect(isSkillboxError(caught)).toBe(true)
    if (isSkillboxError(caught)) {
      expect(caught.code).toBe(ErrorCode.GIT_NOT_FOUND)
      expect(caught.context).toMatchObject({ repositoryRoot: '/some/repo' })
    }
  })

  it('isInstalled reports false only when git is truly missing', async () => {
    const notFound = new Error('spawn git ENOENT')
    ;(notFound as NodeJS.ErrnoException).code = 'ENOENT'
    const missing = new GitClient({
      spawn: async () => {
        throw notFound
      },
    })
    expect(await missing.isInstalled()).toBe(false)
    const present = new GitClient()
    expect(await present.isInstalled()).toBe(true)
  })

  it('wraps a non-zero exit as GIT_COMMAND_FAILED with stderr context', async () => {
    const client = new GitClient({
      spawn: async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    })
    let caught: unknown
    try {
      await client.status('/some/repo')
    } catch (error) {
      caught = error
    }
    expect(isSkillboxError(caught)).toBe(true)
    if (isSkillboxError(caught)) {
      expect(caught.code).toBe(ErrorCode.GIT_COMMAND_FAILED)
      expect(caught.context).toMatchObject({ exitCode: 128 })
      expect(caught.message).toContain('fatal: not a git repository')
    }
  })
})
