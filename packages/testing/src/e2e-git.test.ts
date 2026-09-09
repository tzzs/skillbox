import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import { createCliHarness, workspaceRootOf, type CliHarness } from './cli-harness.js'
import { createBareRemoteFixture, runGit, type BareRemoteFixture } from './git-fixture.js'

/**
 * Hermetic CLI E2E journeys over a real local git remote (roadmap 3.2):
 * `create → commit → push → second-clone → pull`. Requires the workspace to
 * be built (`pnpm build`) and the system `git` binary; the suite self-skips
 * when either is missing (CI ubuntu-latest has both).
 */
const workspaceRoot = workspaceRootOf(import.meta.url)
const cliUnbuilt = !fsSync.existsSync(
  path.join(workspaceRoot, 'packages', 'cli', 'dist', 'index.js'),
)

/** Synchronous probe: the suite needs a working system git binary. */
function gitUnavailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return false
  } catch {
    return true
  }
}

describe.skipIf(cliUnbuilt || gitUnavailable())('Hermetic CLI E2E (git journeys)', () => {
  let cli: CliHarness
  let fixture: BareRemoteFixture

  beforeAll(async () => {
    cli = await createCliHarness({ workspaceRoot })
    fixture = await createBareRemoteFixture()
  })

  afterAll(async () => {
    await fixture.cleanup()
    await cli.cleanup()
  })

  it('creates a skill, commits and pushes it to the remote', async () => {
    const created = await cli.run(['create', 'hello', '--description', 'demo'], {
      cwd: fixture.repoDir,
    })
    expect(created.exitCode).toBe(0)

    const added = await runGit(['add', '-A'], { cwd: fixture.repoDir })
    expect(added.exitCode).toBe(0)
    const committed = await runGit(['commit', '-m', 'init'], { cwd: fixture.repoDir })
    expect(committed.exitCode).toBe(0)
    const pushed = await runGit(['push', '-u', 'origin', 'main'], { cwd: fixture.repoDir })
    expect(pushed.exitCode).toBe(0)
  })

  it('a fresh clone pulls and reconciles the skill from the remote', async () => {
    const cloned = await runGit(['clone', fixture.remoteDir, fixture.secondRepoDir], {
      cwd: path.dirname(fixture.secondRepoDir),
    })
    expect(cloned.exitCode).toBe(0)

    const pulled = await cli.run(['pull'], { cwd: fixture.secondRepoDir })
    expect(pulled.exitCode).toBe(0)

    const status = await cli.run(['status', '--json'], { cwd: fixture.secondRepoDir })
    expect(status.exitCode).toBe(0)
    const body = JSON.parse(status.stdout) as {
      skills: Array<{ name: string }>
      git: { remote?: { name: string } } | null
    }
    expect(body.skills).toContainEqual(expect.objectContaining({ name: 'hello' }))
    expect(body.git?.remote?.name).toBe('origin')
  })
})
