import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createCliHarness, workspaceRootOf, type CliHarness } from './cli-harness.js'

/**
 * Hermetic CLI E2E journeys (roadmap 3.2, git-free slice): the packaged CLI
 * runs as a real subprocess against a fresh `SKILLBOX_HOME` + repository.
 *
 * Requires the workspace to be built (`pnpm build` compiles `packages/cli` →
 * `dist`); the suite self-skips with a hint when the CLI is not built yet.
 */
const workspaceRoot = workspaceRootOf(import.meta.url)
/** Synchronous probe: the CLI dist must exist for the subprocess to run. */
const cliUnbuilt = !fsSync.existsSync(
  path.join(workspaceRoot, 'packages', 'cli', 'dist', 'index.js'),
)

describe.skipIf(cliUnbuilt)('Hermetic CLI E2E (git-free journeys)', () => {
  let cli: CliHarness

  beforeAll(async () => {
    cli = await createCliHarness({ workspaceRoot })
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it('prints the version and exits 0', async () => {
    const result = await cli.run(['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('0.1.0')
  })

  it('scaffolds a skill, lists and removes it (create → list → remove)', async () => {
    const created = await cli.run(['create', 'hello', '--description', 'demo skill'])
    expect(created.exitCode).toBe(0)
    expect(created.stdout).toContain('Created skill "hello"')

    // The skill files land in the repository and the managed library.
    await expect(
      fs.readFile(path.join(cli.repositoryRoot, 'skills', 'hello', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('# hello')
    await expect(
      fs.access(path.join(cli.homeRoot, 'library', 'local', 'hello', 'SKILL.md')),
    ).resolves.toBeUndefined()

    const listed = await cli.run(['list', '--json'])
    expect(listed.exitCode).toBe(0)
    const listBody = JSON.parse(listed.stdout) as { skills: Array<{ name: string; mode: string }> }
    expect(listBody.skills).toContainEqual(
      expect.objectContaining({ name: 'hello', mode: 'local' }),
    )

    const status = await cli.run(['status', '--json'])
    expect(status.exitCode).toBe(0)
    const statusBody = JSON.parse(status.stdout) as { skills: Array<{ name: string }> }
    expect(statusBody.skills).toContainEqual(expect.objectContaining({ name: 'hello' }))

    const removed = await cli.run(['remove', 'hello'])
    expect(removed.exitCode).toBe(0)
    expect(removed.stdout).toContain('Removed skill "hello"')

    const after = await cli.run(['list', '--json'])
    const afterBody = JSON.parse(after.stdout) as { skills: unknown[] }
    expect(afterBody.skills).toHaveLength(0)
  })

  it('reconciles an empty repository with install (no problems)', async () => {
    const result = await cli.run(['install'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Reconciled')
  })

  it('surfaces a typed error for an unknown command', async () => {
    const result = await cli.run(['definitely-not-a-command'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length + result.stdout.length).toBeGreaterThan(0)
  })
})
