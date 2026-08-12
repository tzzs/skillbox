import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitClient } from '../git/index.js'
import { ErrorCode, SkillboxError } from '../errors.js'
import { SyncTransaction } from './sync-transaction.js'

const roots: string[] = []

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, _stdout, stderr) => {
      if (error === null) resolve()
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))
    })
  })
}

async function fixture(): Promise<{ root: string; local: string; other: string; home: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-sync-e2e-'))
  roots.push(root)
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  const local = path.join(root, 'local')
  const other = path.join(root, 'other')
  const home = path.join(root, 'home')
  await git(root, ['init', '--bare', remote])
  await fs.mkdir(seed)
  await git(seed, ['init', '--initial-branch=main'])
  await configure(seed)
  await fs.writeFile(path.join(seed, 'skillbox.yaml'), 'version: 1\nskills: {}\n')
  await fs.writeFile(path.join(seed, 'skillbox.lock'), 'lockfileVersion: 1\nskills: {}\n')
  await git(seed, ['add', '.'])
  await git(seed, ['commit', '-m', 'seed'])
  await git(seed, ['remote', 'add', 'origin', remote])
  await git(seed, ['push', '-u', 'origin', 'main'])
  // A freshly created bare repository still points HEAD at `master`; make
  // clones track the branch seeded above on hosts with that legacy default.
  await git(root, ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(root, ['clone', remote, local])
  await git(root, ['clone', remote, other])
  await configure(local)
  await configure(other)
  return { root, local, other, home }
}

async function configure(repository: string): Promise<void> {
  await git(repository, ['config', 'user.email', 'skillbox-test@example.com'])
  await git(repository, ['config', 'user.name', 'Skillbox Test'])
}

function transaction(repositoryRoot: string, homeRoot: string): SyncTransaction {
  return new SyncTransaction({
    repositoryRoot,
    homeRoot,
    git: new GitClient(),
    auth: async () => ({ prefixArgs: [], env: {}, sensitiveEnvKeys: [] }),
    event: () => undefined,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeFixture))
})

async function removeFixture(root: string): Promise<void> {
  // Linked worktrees can keep a transient handle open on Windows immediately
  // after `git worktree remove`; bounded retry keeps this integration fixture
  // from masking a transaction assertion with an unrelated EBUSY cleanup race.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

describe('SyncTransaction real Git integration', { timeout: 60_000 }, () => {
  it('recognizes an already synchronized repository without creating a snapshot', async () => {
    const { local, home } = await fixture()

    await expect(transaction(local, home).run()).resolves.toEqual({
      kind: 'completed',
      summary: { automaticallyMerged: 0, retriedPushes: 0 },
    })
    await expect(fs.readdir(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates a persisted semantic conflict session from divergent device commits', async () => {
    const { local, other, home } = await fixture()
    const localSkill = path.join(local, 'skills', 'demo')
    const otherSkill = path.join(other, 'skills', 'demo')
    for (const skill of [localSkill, otherSkill]) await fs.mkdir(skill, { recursive: true })
    const manifest =
      'version: 1\nskills:\n  demo:\n    source:\n      type: local\n      path: skills/demo\n'
    for (const repository of [local, other])
      await fs.writeFile(path.join(repository, 'skillbox.yaml'), manifest)
    await fs.writeFile(path.join(localSkill, 'SKILL.md'), '# local\n')
    await fs.writeFile(path.join(otherSkill, 'SKILL.md'), '# remote\n')
    await git(local, ['add', '.'])
    await git(local, ['commit', '-m', 'local change'])
    await git(other, ['add', '.'])
    await git(other, ['commit', '-m', 'remote change'])
    await git(other, ['push'])

    const outcome = await transaction(local, home).run()

    expect(outcome.kind).toBe('conflicts')
    if (outcome.kind !== 'conflicts') return
    expect(outcome.session.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'content', skillAlias: 'demo', path: 'SKILL.md' }),
      ]),
    )
    const persisted = path.join(home, 'state', 'sync', 'sessions')
    await expect(fs.readdir(persisted, { recursive: true })).resolves.toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`${outcome.session.id}\\.json$`))]),
    )
    await expect(fs.readFile(path.join(localSkill, 'SKILL.md'), 'utf8')).resolves.toBe('# local\n')
  }, 20_000)

  it('publishes a two-parent semantic merge for non-overlapping device skills', async () => {
    const { root, local, other, home } = await fixture()
    await addSkill(local, 'local-skill', '# local\n')
    await git(local, ['add', '.'])
    await git(local, ['commit', '-m', 'add local skill'])
    await addSkill(other, 'remote-skill', '# remote\n')
    await git(other, ['add', '.'])
    await git(other, ['commit', '-m', 'add remote skill'])
    await git(other, ['push'])

    const outcome = await transaction(local, home).run()

    expect(outcome).toMatchObject({
      kind: 'completed',
      summary: { automaticallyMerged: 2, retriedPushes: 0 },
    })
    const observer = path.join(root, 'observer')
    await git(root, ['clone', path.join(root, 'remote.git'), observer])
    await expect(
      fs.readFile(path.join(observer, 'skills', 'local-skill', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# local\n')
    await expect(
      fs.readFile(path.join(observer, 'skills', 'remote-skill', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# remote\n')
  }, 25_000)

  it('retries a transient push rejection without rebuilding the transaction', async () => {
    const { local, other, home } = await fixture()
    await addSkill(local, 'local-skill', '# local\n')
    await git(local, ['add', '.'])
    await git(local, ['commit', '-m', 'add local skill'])
    await addSkill(other, 'remote-skill', '# remote\n')
    await git(other, ['add', '.'])
    await git(other, ['commit', '-m', 'add remote skill'])
    await git(other, ['push'])
    const client = new GitClient()
    const flaky = Object.create(client) as GitClient
    let pushes = 0
    flaky.push = async (repositoryRoot, options) => {
      pushes++
      if (pushes === 1)
        throw new SkillboxError(ErrorCode.GIT_PUSH_REJECTED, 'simulated transient rejection')
      return client.push(repositoryRoot, options)
    }
    const outcome = await new SyncTransaction({
      repositoryRoot: local,
      homeRoot: home,
      git: flaky,
      auth: async () => ({ prefixArgs: [], env: {}, sensitiveEnvKeys: [] }),
      event: () => undefined,
    }).run()

    expect(outcome).toMatchObject({ kind: 'completed', summary: { retriedPushes: 1 } })
    expect(pushes).toBe(2)
  }, 25_000)

  it('applies a local content choice in an isolated tree and publishes it', async () => {
    const { local, other, home } = await fixture()
    await addSkill(local, 'demo', '# local\n')
    await addSkill(other, 'demo', '# remote\n')
    await git(local, ['add', '.'])
    await git(local, ['commit', '-m', 'local change'])
    await git(other, ['add', '.'])
    await git(other, ['commit', '-m', 'remote change'])
    await git(other, ['push'])
    const conflict = await transaction(local, home).run()
    expect(conflict.kind).toBe('conflicts')
    if (conflict.kind !== 'conflicts') return

    const outcome = await transaction(local, home).resolve(
      conflict.session,
      Object.fromEntries(conflict.session.conflicts.map((item) => [item.id, 'local'])) as Record<
        string,
        'local'
      >,
    )

    expect(outcome).toMatchObject({ kind: 'completed' })
    await expect(fs.readFile(path.join(local, 'skills', 'demo', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# local\n',
    )
  }, 30_000)
})

async function addSkill(repository: string, alias: string, content: string): Promise<void> {
  const skillRoot = path.join(repository, 'skills', alias)
  await fs.mkdir(skillRoot, { recursive: true })
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), content)
  await fs.writeFile(
    path.join(repository, 'skillbox.yaml'),
    `version: 1\nskills:\n  ${alias}:\n    source:\n      type: local\n      path: skills/${alias}\n`,
  )
}
