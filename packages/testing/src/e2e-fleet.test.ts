import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import { createCliHarness, workspaceRootOf, type CliHarness } from './cli-harness.js'

/**
 * Hermetic CLI E2E journeys for the fleet and multi-device-sync surfaces
 * (roadmap 3.2, git-free + SSH-free slice). Fleet host management is pure
 * `.skillbox/fleet.yaml` CRUD and `--dry-run` renders the remote command
 * without ever contacting a host, so neither needs SSH or a network — the
 * suite only requires the workspace to be built (`pnpm build`).
 */
const workspaceRoot = workspaceRootOf(import.meta.url)
const cliUnbuilt = !fsSync.existsSync(
  path.join(workspaceRoot, 'packages', 'cli', 'dist', 'index.js'),
)

interface FleetHostJson {
  name: string
  host: string
  user?: string
  tags?: string[]
}

describe.skipIf(cliUnbuilt)('Hermetic CLI E2E (fleet + sync snapshot journeys)', () => {
  let cli: CliHarness

  beforeAll(async () => {
    cli = await createCliHarness({ workspaceRoot })
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  // Runs first, on a pristine temp repo with no `.skillbox/fleet.yaml`.
  it('refuses a fleet run before any fleet.yaml exists', async () => {
    const result = await cli.run(['fleet', 'status', '--dry-run'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('No fleet.yaml found')
  })

  it('adds, lists, edits and removes a fleet host (fleet.yaml CRUD)', async () => {
    const added = await cli.run([
      'fleet',
      'host',
      'add',
      'web',
      'app.example.com',
      '-u',
      'deploy',
      '--tag',
      'prod',
      '--json',
    ])
    expect(added.exitCode).toBe(0)
    const addedBody = JSON.parse(added.stdout) as { host: FleetHostJson }
    expect(addedBody.host).toMatchObject({ name: 'web', host: 'app.example.com', user: 'deploy' })

    const listed = await cli.run(['fleet', 'list', '--json'])
    expect(listed.exitCode).toBe(0)
    const listBody = JSON.parse(listed.stdout) as { hosts: FleetHostJson[] }
    expect(listBody.hosts).toContainEqual(expect.objectContaining({ name: 'web' }))

    const edited = await cli.run(['fleet', 'host', 'edit', 'web', '--rename', 'web-1', '--json'])
    expect(edited.exitCode).toBe(0)

    const afterEdit = await cli.run(['fleet', 'list', '--json'])
    const afterEditBody = JSON.parse(afterEdit.stdout) as { hosts: FleetHostJson[] }
    expect(afterEditBody.hosts).toContainEqual(expect.objectContaining({ name: 'web-1' }))
    expect(afterEditBody.hosts.some((host) => host.name === 'web')).toBe(false)

    const removed = await cli.run(['fleet', 'host', 'remove', 'web-1', '--json'])
    expect(removed.exitCode).toBe(0)
    const finalList = await cli.run(['fleet', 'list', '--json'])
    const finalBody = JSON.parse(finalList.stdout) as { hosts: FleetHostJson[] }
    expect(finalBody.hosts).toHaveLength(0)
  })

  it('renders the remote command for a dry-run status without contacting any host', async () => {
    await cli.run(['fleet', 'host', 'add', 'web', 'app.example.com'])
    const dryRun = await cli.run(['fleet', 'status', '--dry-run', '--json'])
    expect(dryRun.exitCode).toBe(0)
    const body = JSON.parse(dryRun.stdout) as {
      operation: string
      results: Array<{ host: string; ok: boolean; exitCode: number | null; stdout: string }>
    }
    expect(body.operation).toBe('status')
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ host: 'web', ok: true, exitCode: null })
    // Dry-run prints the command it *would* run; it never opens an SSH session.
    expect(body.results[0]?.stdout).toContain('status')
  })

  it('lists multi-device sync restore points on an unconnected repository (empty)', async () => {
    const result = await cli.run(['sync', '--multi-device', '--list-snapshots'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('no sync restore points yet')
  })
})
