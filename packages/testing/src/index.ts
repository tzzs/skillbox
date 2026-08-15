import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function createTempDir(prefix = 'skillbox-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export * from './cli-harness.js'
export * from './git-fixture.js'
