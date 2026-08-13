import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCliHarness, type CliHarness } from './cli-harness.js'

// Packaged Node subprocesses and recursive temp cleanup exceed Vitest's
// default 5s budget on Windows CI runners.
const E2E_TIMEOUT_MS = 30_000

describe('CLI E2E harness', () => {
  const fixtures: CliHarness[] = []

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  }, E2E_TIMEOUT_MS)

  it('runs a subprocess with an isolated home and repository', async () => {
    const bootstrap = await createCliHarness()
    fixtures.push(bootstrap)
    const script = join(bootstrap.root, 'echo-env.mjs')
    await writeFile(
      script,
      'console.log(JSON.stringify({home: process.env.SKILLBOX_HOME, cwd: process.cwd(), args: process.argv.slice(2)}))\n',
    )
    const fixture = await createCliHarness({ entrypoint: script })
    fixtures.push(fixture)

    const result = await fixture.run(['status'])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      home: join(fixture.home, '.skillbox'),
      cwd: fixture.repository,
      args: ['status'],
    })
    await expect(access(fixture.home)).resolves.toBeUndefined()
  })

  it('creates and lists a skill through the packaged CLI in an isolated repository', async () => {
    const fixture = await createCliHarness()
    fixtures.push(fixture)

    const created = await fixture.run([
      'create',
      'focus-mode',
      '--description',
      'Protect focus time',
    ])
    const listed = await fixture.run(['list', '--json'])

    expect(created.exitCode).toBe(0)
    expect(created.stdout).toContain('Created skill "focus-mode" (local)')
    expect(listed.exitCode).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual({
      skills: [
        expect.objectContaining({
          name: 'focus-mode',
          mode: 'local',
          status: 'ready',
        }),
      ],
    })
    await expect(readFile(join(fixture.repository, 'skillbox.yaml'), 'utf8')).resolves.toContain(
      'focus-mode:',
    )
    await expect(
      access(join(fixture.home, '.skillbox', 'library', 'local', 'focus-mode', 'SKILL.md')),
    ).resolves.toBeUndefined()
  }, E2E_TIMEOUT_MS)
})
