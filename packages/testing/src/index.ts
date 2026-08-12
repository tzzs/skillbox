import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function createTempDir(prefix = 'skillbox-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeTempDir(dir: string): Promise<void> {
  // Windows can keep a just-exited child process' cwd or stream handle open
  // briefly. Bounded native retries avoid turning a successful E2E assertion
  // into an unrelated ENOTEMPTY/EBUSY cleanup failure.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export {
  createCliHarness,
  type CliHarness,
  type CliHarnessOptions,
  type CliRunResult,
} from './cli-harness.js'
export { createBareGitRemoteFixture, type BareGitRemoteFixture } from './git-fixture.js'
export {
  createHttpFixture,
  type HttpFixture,
  type HttpFixtureHandler,
  type HttpFixtureRequest,
  type HttpFixtureResponse,
} from './http-fixture.js'
