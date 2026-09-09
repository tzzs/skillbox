import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CliRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CliRunOptions {
  /** Working directory for the subprocess (defaults to the repository root). */
  cwd?: string
  /** Extra environment variables merged over the harness defaults. */
  env?: NodeJS.ProcessEnv
  /** Kill the subprocess after this many milliseconds (default 30s). */
  timeoutMs?: number
}

export interface CliHarness {
  /** Temp SKILLBOX home passed to every subprocess (`SKILLBOX_HOME`). */
  homeRoot: string
  /** Temp working directory used as the repository by default. */
  repositoryRoot: string
  /** Absolute path of the CLI bin executed by {@link run}. */
  cliBin: string
  run(args: readonly string[], options?: CliRunOptions): Promise<CliRunResult>
  /** Removes the temp home and repository. */
  cleanup(): Promise<void>
}

/** Workspace root, detected relative to this source file. */
export function workspaceRootOf(importMetaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..', '..', '..')
}

/** Default CLI bin path for a workspace root (`packages/cli/bin/skillbox.mjs`). */
export function defaultCliBin(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'packages', 'cli', 'bin', 'skillbox.mjs')
}

/** Whether the packaged CLI has been built (`dist` present). */
export async function isCliBuilt(cliBin: string): Promise<boolean> {
  return fs
    .access(path.join(path.dirname(cliBin), '..', 'dist', 'index.js'))
    .then(() => true)
    .catch(() => false)
}

function runCli(
  cliBin: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CliRunResult> {
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL')
      }
    }, options.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== null) {
        resolve({ exitCode: 1, stdout, stderr: `${stderr}killed by signal ${signal}` })
        return
      }
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * Hermetic CLI subprocess harness (roadmap 3.1): every run gets a fresh
 * temp `SKILLBOX_HOME` and repository directory, executes the packaged CLI
 * (`node packages/cli/bin/skillbox.mjs`) as a real child process, and returns
 * stdout/stderr/exit code. Cross-platform temp dirs are cleaned up with retries.
 */
export async function createCliHarness(
  options: {
    workspaceRoot?: string
    cliBin?: string
  } = {},
): Promise<CliHarness> {
  const workspaceRoot = options.workspaceRoot ?? workspaceRootOf(import.meta.url)
  const cliBin = options.cliBin ?? defaultCliBin(workspaceRoot)
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-e2e-'))
  const homeRoot = path.join(base, 'home')
  const repositoryRoot = path.join(base, 'repo')
  await fs.mkdir(homeRoot, { recursive: true })
  await fs.mkdir(repositoryRoot, { recursive: true })

  const run = (args: readonly string[], runOptions: CliRunOptions = {}): Promise<CliRunResult> =>
    runCli(cliBin, args, {
      cwd: runOptions.cwd ?? repositoryRoot,
      env: { ...process.env, SKILLBOX_HOME: homeRoot, ...runOptions.env },
      timeoutMs: runOptions.timeoutMs ?? 30_000,
    })

  const cleanup = async (): Promise<void> => {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  return { homeRoot, repositoryRoot, cliBin, run, cleanup }
}
