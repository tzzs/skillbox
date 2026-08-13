import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBareGitRemoteFixture, type BareGitRemoteFixture } from './git-fixture.js'

// Real Git process startup and filesystem cleanup are routinely slower than
// Vitest's 5s default on Windows CI runners.
const E2E_TIMEOUT_MS = 30_000

describe('bare Git remote fixture', () => {
  const fixtures: BareGitRemoteFixture[] = []

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  }, E2E_TIMEOUT_MS)

  it('pushes to a local bare remote without network access', async () => {
    const fixture = await createBareGitRemoteFixture()
    fixtures.push(fixture)
    await writeFile(join(fixture.repository, 'skill.txt'), 'offline\n')
    await fixture.git(['add', '.'])
    await fixture.git(['commit', '-m', 'fixture seed'])
    await fixture.git(['push', '-u', 'origin', 'HEAD:main'])

    await expect(
      fixture.git(['--git-dir', fixture.remote, 'rev-parse', 'main'], fixture.root),
    ).resolves.toMatch(/^[0-9a-f]{40}\n$/u)
  }, E2E_TIMEOUT_MS)
})
