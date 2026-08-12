import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createTempDir, removeTempDir } from './index.js'

export interface CliRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CliHarnessOptions {
  /** A built CLI entrypoint. Defaults to Skillbox's package bin script. */
  entrypoint?: string
  env?: NodeJS.ProcessEnv
}

export interface CliHarness {
  root: string
  home: string
  repository: string
  entrypoint: string
  /** Runs the packaged CLI in an isolated home and repository. */
  run(args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }): Promise<CliRunResult>
  cleanup(): Promise<void>
}

const defaultEntrypoint = fileURLToPath(new URL('../../cli/bin/skillbox.mjs', import.meta.url))

/**
 * Creates an isolated process boundary for CLI end-to-end tests.  It never
 * inherits the developer's Skillbox or Git configuration: HOME, USERPROFILE,
 * XDG_CONFIG_HOME, and SKILLBOX_HOME all point into the disposable fixture.
 */
export async function createCliHarness(options: CliHarnessOptions = {}): Promise<CliHarness> {
  const root = await createTempDir('skillbox-cli-e2e-')
  const home = join(root, 'home')
  const repository = join(root, 'repository')
  await Promise.all([mkdir(home, { recursive: true }), mkdir(repository, { recursive: true })])

  const entrypoint = options.entrypoint ?? defaultEntrypoint
  const isolatedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    SKILLBOX_HOME: join(home, '.skillbox'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    NO_PROXY: '*',
    no_proxy: '*',
  }

  return {
    root,
    home,
    repository,
    entrypoint,
    run: async (args = [], runOptions = {}) =>
      runProcess(process.execPath, [entrypoint, ...args], repository, {
        ...isolatedEnv,
        ...runOptions.env,
      }),
    cleanup: () => removeTempDir(root),
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }))
  })
}
