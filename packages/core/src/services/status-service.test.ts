import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { withTempDir } from '../fs/test-utils.js'
import { writeManifest, emptyManifest, addSkill } from '../manifest/index.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { reconcile } from '../reconcile/engine.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { StatusService } from './status-service.js'
import { GitClient, remoteCacheKey } from '../git/index.js'

function rawGit(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))
        return
      }
      resolve(stdout ?? '')
    })
  })
}

/** Seeds a bare remote with `remote/skills/<alias>/SKILL.md` committed. */
async function seedRemoteSkill(dir: string, alias: string): Promise<string> {
  const remote = path.join(dir, 'remote.git')
  await rawGit(dir, ['init', '--bare', '--initial-branch=main', remote])
  const work = path.join(dir, 'seed-work')
  await fs.mkdir(work, { recursive: true })
  await rawGit(work, ['init', '--initial-branch=main'])
  await rawGit(work, ['config', 'user.email', 'status-test@example.com'])
  await rawGit(work, ['config', 'user.name', 'Status Test'])
  const skillDir = path.join(work, 'skills', alias)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${alias}`, 'utf8')
  await rawGit(work, ['add', 'skills'])
  await rawGit(work, ['commit', '-m', 'seed'])
  await rawGit(work, ['remote', 'add', 'origin', remote])
  await rawGit(work, ['push', '-u', 'origin', 'main'])
  return remote
}

describe('StatusService remote sources', () => {
  it('reports a remote skill as missing until it is materialized, then ready', async () => {
    await withTempDir(async (dir) => {
      const remote = await seedRemoteSkill(dir, 'hello')
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'git', url: remote, path: 'skills/hello', ref: 'main' },
        agents: ['claude'],
      })
      await writeManifest(repoRoot, manifest)

      const remoteRoot = path.join(dir, 'remotes')
      const status = new StatusService({ repositoryRoot: repoRoot, remoteRoot })

      const before = await status.status()
      const helloBefore = before.skills.find((skill) => skill.name === 'hello')
      expect(helloBefore?.status).toBe('missing')
      expect(helloBefore?.message).toMatch(/not materialized/)

      // reconcile materializes the mirror; a second status is read-only-ready
      const layout = buildSkillboxHomeLayout(path.join(dir, 'home'))
      const library = new RuntimeLibraryService(layout.library)
      const linkState = new RuntimeLinkState({ filePath: layout.linksFile })
      await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        git: new GitClient(),
        remoteRoot,
      })

      const after = await status.status()
      const helloAfter = after.skills.find((skill) => skill.name === 'hello')
      expect(helloAfter?.status).toBe('ready')
      expect(helloAfter?.mode).toBe('managed')
      expect(helloAfter?.path).toBe(
        path.join(remoteRoot, remoteCacheKey(remote), 'skills', 'hello'),
      )
      expect(helloAfter?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    })
  }, 30000)

  it('marks an unresolvable source path as broken', async () => {
    await withTempDir(async (dir) => {
      const remote = await seedRemoteSkill(dir, 'hello')
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'git', url: remote, path: '../escape', ref: 'main' },
      })
      await writeManifest(repoRoot, manifest)

      const status = new StatusService({
        repositoryRoot: repoRoot,
        remoteRoot: path.join(dir, 'remotes'),
      })
      const report = await status.status()
      const hello = report.skills.find((skill) => skill.name === 'hello')
      expect(hello?.status).toBe('broken')
      expect(hello?.message).toMatch(/unresolvable/)
    })
  })

  it('keeps registry sources as a non-git status message', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'pack', {
        source: { type: 'registry', registry: 'skills.sh', package: 'org/pack' },
      })
      await writeManifest(repoRoot, manifest)

      const status = new StatusService({ repositoryRoot: repoRoot })
      const report = await status.status()
      const pack = report.skills.find((skill) => skill.name === 'pack')
      expect(pack?.status).toBe('missing')
      expect(pack?.message).toMatch(/registry/)
    })
  })
})
