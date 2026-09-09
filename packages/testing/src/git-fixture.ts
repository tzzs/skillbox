import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export interface GitExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function runGit(
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<GitExecResult> {
  return new Promise<GitExecResult>((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          // Hermetic identity so `git commit` never touches the user config.
          GIT_AUTHOR_NAME: 'skillbox e2e',
          GIT_AUTHOR_EMAIL: 'e2e@skillbox.invalid',
          GIT_COMMITTER_NAME: 'skillbox e2e',
          GIT_COMMITTER_EMAIL: 'e2e@skillbox.invalid',
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr })
          return
        }
        resolve({
          exitCode: typeof error.code === 'number' ? error.code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        })
      },
    )
  })
}

/** Whether the system git binary responds (`git --version`). */
export async function isGitAvailable(): Promise<boolean> {
  const result = await runGit(['--version'], { cwd: os.tmpdir() })
  return result.exitCode === 0
}

export interface BareRemoteFixture {
  /** Bare remote directory (`remote.git`). */
  remoteDir: string
  /** First clone used as the primary skillbox repository. */
  repoDir: string
  /** Second clone (fresh machine simulation) used for pull journeys. */
  secondRepoDir: string
  /** Removes the whole fixture. */
  cleanup(): Promise<void>
}

/**
 * Hermetic bare-git-remote fixture (roadmap 3.1): a bare remote plus two
 * clones, so journeys can exercise `create → commit → push → clone → pull`
 * with the real CLI subprocess and real git — no network, no GitHub.
 */
export async function createBareRemoteFixture(): Promise<BareRemoteFixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-e2e-git-'))
  const remoteDir = path.join(base, 'remote.git')
  const repoDir = path.join(base, 'repo')
  const secondRepoDir = path.join(base, 'repo2')

  const init = await runGit(['init', '--bare', '--initial-branch=main', remoteDir], {
    cwd: base,
  })
  if (init.exitCode !== 0) {
    await fs.rm(base, { recursive: true, force: true })
    throw new Error(`git init --bare failed: ${init.stderr}`)
  }
  const clone = await runGit(['clone', remoteDir, repoDir], { cwd: base })
  if (clone.exitCode !== 0) {
    await fs.rm(base, { recursive: true, force: true })
    throw new Error(`git clone failed: ${clone.stderr}`)
  }

  return {
    remoteDir,
    repoDir,
    secondRepoDir,
    cleanup: async () => {
      await fs.rm(base, { recursive: true, force: true })
    },
  }
}
