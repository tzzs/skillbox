import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode, SkillboxError } from '../errors.js'
import { SnapshotService, type SnapshotGitPort } from './snapshot-service.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-snapshot-'))
  roots.push(root)
  const repositoryRoot = path.join(root, 'repository')
  const homeRoot = path.join(root, 'home')
  await fs.mkdir(path.join(repositoryRoot, 'skills', 'demo'), { recursive: true })
  await fs.writeFile(path.join(repositoryRoot, 'skillbox.yaml'), 'before\n')
  await fs.writeFile(path.join(repositoryRoot, 'skillbox.lock'), 'lock-before\n')
  await fs.writeFile(path.join(repositoryRoot, 'skills', 'demo', 'SKILL.md'), '# before\n')
  await fs.writeFile(path.join(repositoryRoot, 'unmanaged.txt'), 'leave me\n')
  const refs = new Map<string, string>()
  const git: SnapshotGitPort = {
    revParse: async () => 'a'.repeat(40),
    createPrivateRef: async (_root, name, revision) => void refs.set(name, revision),
    deletePrivateRef: async (_root, name) => void refs.delete(name),
  }
  return { repositoryRoot, homeRoot, refs, git }
}

describe('SnapshotService', () => {
  it('restores dirty managed paths without overwriting unmanaged files', async () => {
    const { repositoryRoot, homeRoot, refs, git } = await fixture()
    const service = new SnapshotService({ repositoryRoot, homeRoot, git })
    const snapshot = await service.create({ id: 'restore-point' })
    await fs.writeFile(path.join(repositoryRoot, 'skillbox.yaml'), 'after\n')
    await fs.rm(path.join(repositoryRoot, 'skills'), { recursive: true })
    await fs.writeFile(path.join(repositoryRoot, 'unmanaged.txt'), 'still mine\n')

    await service.restore(snapshot.id)

    await expect(fs.readFile(path.join(repositoryRoot, 'skillbox.yaml'), 'utf8')).resolves.toBe(
      'before\n',
    )
    await expect(
      fs.readFile(path.join(repositoryRoot, 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# before\n')
    await expect(fs.readFile(path.join(repositoryRoot, 'unmanaged.txt'), 'utf8')).resolves.toBe(
      'still mine\n',
    )
    expect(refs.get(snapshot.ref)).toBe('a'.repeat(40))
  })

  it('rejects a restore point from another repository', async () => {
    const first = await fixture()
    const snapshot = await new SnapshotService(first).create({ id: 'shared-point' })
    const second = await fixture()
    const foreign = new SnapshotService({ ...second, homeRoot: first.homeRoot })
    await expect(foreign.restore(snapshot.id)).rejects.toMatchObject({
      code: ErrorCode.SYNC_SNAPSHOT_NOT_FOUND,
    } satisfies Partial<SkillboxError>)
  })
})
