import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitClient } from '../git/index.js'
import { ErrorCode, SkillboxError } from '../errors.js'
import { readManifest } from '../manifest/index.js'
import { RepositorySyncService } from './repository-sync.js'
import { SyncTransaction } from './sync-transaction.js'
import type { ConflictResolution, ConflictSession, RepositoryHostPort } from './types.js'

const roots: string[] = []

/** Runs git and resolves with its stdout so a test can read `ls-files`/`ls-tree`. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout)
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))
    })
  })
}

/** Tracked paths under `skills`, as the working tree's index records them. */
async function trackedSkills(repository: string): Promise<string[]> {
  const stdout = await git(repository, ['ls-files', 'skills'])
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .sort()
}

/** Paths under `skills` inside a commit — the only thing a peer device ever sees. */
async function committedSkills(repository: string, ref = 'HEAD'): Promise<string[]> {
  const stdout = await git(repository, ['ls-tree', '-r', '--name-only', ref])
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('skills/'))
    .sort()
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
  // Disable line-ending normalization for every clone in this fixture (via
  // .gitattributes, committed once here and inherited by every clone/checkout
  // through history) — otherwise Windows git's default core.autocrlf=true
  // rewrites the LF-only fixture content to CRLF on checkout, breaking the
  // exact-byte assertions below on Windows CI.
  await fs.writeFile(path.join(seed, '.gitattributes'), '* -text\n')
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
  it('recognizes an already synchronized repository without creating a sync restore point', async () => {
    const { local, home } = await fixture()

    await expect(transaction(local, home).run()).resolves.toEqual({
      kind: 'completed',
      summary: { automaticallyMerged: 0, retriedPushes: 0 },
    })
    await expect(fs.readdir(path.join(home, 'state', 'sync', 'snapshots'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
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
  await writeManifestEntry(repository, alias, '')
}

/** Points a repository's single manifest entry at a local skill, plus extra YAML lines. */
async function writeManifestEntry(
  repository: string,
  alias: string,
  extraYaml: string,
): Promise<void> {
  await writeSkillsManifest(repository, [{ alias, extraYaml }])
}

/** Manifest holding exactly these aliases, each a local skill plus its extra YAML lines. */
async function writeSkillsManifest(
  repository: string,
  skills: ReadonlyArray<{ alias: string; extraYaml?: string }>,
): Promise<void> {
  if (skills.length === 0) {
    await fs.writeFile(path.join(repository, 'skillbox.yaml'), 'version: 1\nskills: {}\n')
    return
  }
  const body = skills
    .map(
      ({ alias, extraYaml = '' }) =>
        `  ${alias}:\n    source:\n      type: local\n      path: skills/${alias}\n${extraYaml}`,
    )
    .join('')
  await fs.writeFile(path.join(repository, 'skillbox.yaml'), `version: 1\nskills:\n${body}`)
}

async function commit(repository: string, message: string): Promise<void> {
  await git(repository, ['add', '.'])
  await git(repository, ['commit', '-m', message])
}

/**
 * GAP §2.5: `resolveConflicts` checks a submitted choice against the conflict's own
 * `allowedResolutions`, so anything offered is accepted — and a choice the engine has
 * no branch for closes the session while the manifest keeps the three-way default.
 * These are the only values `SyncTransaction.resolve` acts on.
 */
const IMPLEMENTED: readonly string[] = ['local', 'remote', 'keep-both']

/** Every conflict gets `preferred` when it may, otherwise its first legal choice. */
function choicesFor(
  session: ConflictSession,
  preferred: ConflictResolution,
): Record<string, ConflictResolution> {
  const chosen: Record<string, ConflictResolution> = {}
  for (const conflict of session.conflicts) {
    const offered = conflict.allowedResolutions.includes(preferred)
      ? preferred
      : conflict.allowedResolutions[0]
    if (offered === undefined) throw new Error(`conflict ${conflict.id} offers no resolution`)
    chosen[conflict.id] = offered
  }
  return chosen
}

/** Only transport matters to these flows, so no account port is ever called. */
const hostWithoutAccount: RepositoryHostPort = {
  getConnectionState: async () => {
    throw new Error('not expected')
  },
  startDeviceAuthorization: async () => {
    throw new Error('not expected')
  },
  pollDeviceAuthorization: async () => {
    throw new Error('not expected')
  },
  getCurrentUser: async () => {
    throw new Error('not expected')
  },
  getGitTransportAuth: async () => ({ prefixArgs: [], env: {}, sensitiveEnvKeys: [] }),
  resolveRepository: async () => {
    throw new Error('not expected')
  },
  bindRepository: async () => {
    throw new Error('not expected')
  },
  disconnect: async () => {},
}

function repositorySync(repositoryRoot: string, homeRoot: string): RepositorySyncService {
  return new RepositorySyncService({
    repositoryRoot,
    homeRoot,
    git: new GitClient(),
    host: hostWithoutAccount,
  })
}

/**
 * Two devices sharing a `demo` skill: the other device removed the skill entirely,
 * this device kept it and edited its manifest entry.  A deletion against a
 * modification is the one divergence a three-way merge must not silently pick.
 *
 * `bystander` adds a second skill that both devices leave alone, so a test can tell
 * "the accepted deletion was pruned" apart from "the resolve step swept the tree".
 */
async function deleteModifyDivergence(bystander?: {
  alias: string
  content: string
}): Promise<{ root: string; local: string; home: string }> {
  const { root, local, other, home } = await fixture()
  const shared = [{ alias: 'demo' }, ...(bystander ? [{ alias: bystander.alias }] : [])]
  await addSkill(local, 'demo', '# demo\n')
  if (bystander !== undefined) {
    await addSkill(local, bystander.alias, bystander.content)
    await writeSkillsManifest(local, shared)
  }
  await commit(local, 'add demo')
  await git(local, ['push'])
  await git(other, ['pull'])
  await fs.rm(path.join(other, 'skills', 'demo'), { recursive: true, force: true })
  // The deleting device keeps nothing (or only the untouched bystander).
  await writeSkillsManifest(other, bystander ? [{ alias: bystander.alias }] : [])
  await commit(other, 'remove demo')
  await git(other, ['push'])
  await writeSkillsManifest(local, [
    { alias: 'demo', extraYaml: '    enabled: false\n' },
    ...(bystander ? [{ alias: bystander.alias }] : []),
  ])
  await commit(local, 'disable demo')
  return { root, local, home }
}

describe('Conflict resolution vocabulary', { timeout: 60_000 }, () => {
  it('offers a delete/modify choice only what the engine carries out', async () => {
    const { local, home } = await deleteModifyDivergence()

    const outcome = await transaction(local, home).run()

    expect(outcome.kind).toBe('conflicts')
    if (outcome.kind !== 'conflicts') return
    const deleteModify = outcome.session.conflicts.find((item) => item.type === 'delete-modify')
    expect(deleteModify).toBeDefined()
    if (deleteModify === undefined) return
    // The offer list is the contract the user is held to, so it may not contain a
    // word the transaction has no branch for…
    expect(deleteModify.allowedResolutions.filter((one) => !IMPLEMENTED.includes(one))).toEqual([])
    // …and dropping the unimplementable ones must not strand the conflict.
    expect(deleteModify.allowedResolutions.filter((one) => IMPLEMENTED.includes(one))).not.toEqual(
      [],
    )
    // A recommendation the engine ignores is worse than none: it pre-selects a lie.
    expect(
      deleteModify.recommendedResolution === undefined ||
        IMPLEMENTED.includes(deleteModify.recommendedResolution),
    ).toBe(true)
    for (const conflict of outcome.session.conflicts) {
      expect(conflict.allowedResolutions.filter((one) => !IMPLEMENTED.includes(one))).toEqual([])
    }
  })

  it('really removes the skill when the device that deleted it wins', async () => {
    const { local, home } = await deleteModifyDivergence()
    const conflict = await transaction(local, home).run()
    expect(conflict.kind).toBe('conflicts')
    if (conflict.kind !== 'conflicts') return
    const service = repositorySync(local, home)

    const outcome = await service.resolveConflicts({
      sessionId: conflict.session.id,
      resolutions: choicesFor(conflict.session, 'remote'),
    })

    expect(outcome).toMatchObject({ kind: 'completed' })
    expect(Object.keys((await readManifest(local)).skills)).toEqual([])
    await expect(service.listConflicts()).resolves.toEqual([])
  }, 30_000)

  it("really keeps this device's edited skill when the local side wins", async () => {
    const { local, home } = await deleteModifyDivergence()
    const conflict = await transaction(local, home).run()
    expect(conflict.kind).toBe('conflicts')
    if (conflict.kind !== 'conflicts') return
    const service = repositorySync(local, home)

    const outcome = await service.resolveConflicts({
      sessionId: conflict.session.id,
      resolutions: choicesFor(conflict.session, 'local'),
    })

    expect(outcome).toMatchObject({ kind: 'completed' })
    expect((await readManifest(local)).skills['demo']).toMatchObject({ enabled: false })
    await expect(service.listConflicts()).resolves.toEqual([])
    // The other direction is the safe one: this device's skill stays complete on
    // disk and in the commit, exactly as it was before the sync.
    await expect(fs.readFile(path.join(local, 'skills', 'demo', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# demo\n',
    )
    await expect(trackedSkills(local)).resolves.toEqual(['skills/demo/SKILL.md'])
  }, 30_000)
})

/**
 * GAP §2.5, the limit its closing note left behind: `runUnsafe` rebuilds `skills/`
 * from the merged manifest, `resolveUnsafe` does not — it starts from a copy of this
 * device's tree and only ever adds to it.  So accepting another device's deletion
 * dropped the skill from `skillbox.yaml` while its directory was committed anyway,
 * which hands the deleted skill back to every device that syncs from it.
 */
describe('Accepted deletion leaves no orphan directory', { timeout: 60_000 }, () => {
  it('prunes the resolved-away skill from the worktree and from the published commit', async () => {
    const { root, local, home } = await deleteModifyDivergence()
    const conflict = await transaction(local, home).run()
    expect(conflict.kind).toBe('conflicts')
    if (conflict.kind !== 'conflicts') return
    const service = repositorySync(local, home)

    const outcome = await service.resolveConflicts({
      sessionId: conflict.session.id,
      resolutions: choicesFor(conflict.session, 'remote'),
    })

    expect(outcome).toMatchObject({ kind: 'completed' })
    expect(Object.keys((await readManifest(local)).skills)).toEqual([])
    // An untracked leftover directory would be a cosmetic problem; this one is
    // committed, so the shared repository still carries the deleted skill.
    await expect(fs.lstat(path.join(local, 'skills', 'demo'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(trackedSkills(local)).resolves.toEqual([])
    await expect(committedSkills(local)).resolves.toEqual([])
    const observer = path.join(root, 'orphan-observer')
    await git(root, ['clone', path.join(root, 'remote.git'), observer])
    await expect(fs.readdir(path.join(observer, 'skills'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }, 30_000)

  it('prunes only the skill the user resolved away', async () => {
    const { local, home } = await deleteModifyDivergence({
      alias: 'bystander',
      content: '# bystander\n',
    })
    const conflict = await transaction(local, home).run()
    expect(conflict.kind).toBe('conflicts')
    if (conflict.kind !== 'conflicts') return
    // The prune may not be a tree sweep: it has to start from the conflicts.
    expect(conflict.session.conflicts.map((item) => item.skillAlias)).toEqual(['demo'])
    const service = repositorySync(local, home)

    const outcome = await service.resolveConflicts({
      sessionId: conflict.session.id,
      resolutions: choicesFor(conflict.session, 'remote'),
    })

    expect(outcome).toMatchObject({ kind: 'completed' })
    expect(Object.keys((await readManifest(local)).skills)).toEqual(['bystander'])
    await expect(
      fs.readFile(path.join(local, 'skills', 'bystander', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# bystander\n')
    await expect(fs.lstat(path.join(local, 'skills', 'demo'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(trackedSkills(local)).resolves.toEqual(['skills/bystander/SKILL.md'])
    await expect(committedSkills(local)).resolves.toEqual(['skills/bystander/SKILL.md'])
  }, 30_000)

  it('keeps every keep-both copy the resolve step produced', async () => {
    const { local, other, home } = await fixture()
    await addSkill(local, 'demo', '# local\n')
    await addSkill(other, 'demo', '# remote\n')
    await commit(local, 'local change')
    await commit(other, 'remote change')
    await git(other, ['push'])
    const conflict = await transaction(local, home).run()
    expect(conflict.kind).toBe('conflicts')
    if (conflict.kind !== 'conflicts') return

    const outcome = await transaction(local, home).resolve(
      conflict.session,
      choicesFor(conflict.session, 'keep-both'),
    )

    expect(outcome).toMatchObject({ kind: 'completed' })
    const manifest = await readManifest(local)
    expect(Object.keys(manifest.skills).sort()).toEqual(['demo', 'demo-other-device'])
    await expect(fs.readFile(path.join(local, 'skills', 'demo', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# local\n',
    )
    await expect(
      fs.readFile(path.join(local, 'skills', 'demo-other-device', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# remote\n')
    await expect(trackedSkills(local)).resolves.toEqual([
      'skills/demo-other-device/SKILL.md',
      'skills/demo/SKILL.md',
    ])
  }, 30_000)
})
