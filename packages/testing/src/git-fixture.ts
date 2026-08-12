import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempDir, removeTempDir } from './index.js'

export interface BareGitRemoteFixture {
  root: string
  remote: string
  repository: string
  git(args: readonly string[], cwd?: string): Promise<string>
  cleanup(): Promise<void>
}

/**
 * A real local bare remote plus a working clone. It uses no network and makes
 * sync tests exercise Git's actual transport and repository semantics.
 */
export async function createBareGitRemoteFixture(): Promise<BareGitRemoteFixture> {
  const root = await createTempDir('skillbox-git-e2e-')
  const remote = join(root, 'remote.git')
  const repository = join(root, 'repository')
  await mkdir(repository, { recursive: true })

  const git = (args: readonly string[], cwd = repository): Promise<string> => runGit(args, cwd)
  await git(['init', '--bare', remote], root)
  await git(['init'], repository)
  await git(['config', 'user.name', 'Skillbox E2E'], repository)
  await git(['config', 'user.email', 'skillbox-e2e@example.invalid'], repository)
  await git(['remote', 'add', 'origin', remote], repository)

  return { root, remote, repository, git, cleanup: () => removeTempDir(root) }
}

function runGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`))
        return
      }
      resolve(stdout)
    })
  })
}
