import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { GitHubError, GitHubErrorCode } from './errors.js'
import { scrubText } from '../logging/redact.js'

/**
 * OS Credential Store abstraction (SPEC §124/§125.1, ARCHITECTURE §15.3).
 *
 * Values live in the machine's secure store:
 * - macOS: Keychain via the `security` CLI
 * - Windows: Credential Manager via PowerShell `ProtectedData` (DPAPI)
 * - Linux: Secret Service via the `secret-tool` CLI
 * - fallback / tests: in-memory map
 *
 * Tokens stored here never enter config.json, manifests, lockfiles, git
 * remotes, logs, or debug bundles.
 */
export interface CredentialKey {
  /** Namespace, e.g. `skillbox-github`. */
  service: string
  /** Entry name within the service, e.g. `oauth-tokens`. */
  account: string
}

export interface CredentialStore {
  /** Returns the stored value or `null` when there is no entry. */
  get(key: CredentialKey): Promise<string | null>
  /** Creates or updates an entry. */
  set(key: CredentialKey, value: string): Promise<void>
  /** Removes an entry; missing entries are a no-op. */
  delete(key: CredentialKey): Promise<void>
}

export interface CommandRunnerResult {
  code: number
  stdout: string
  stderr: string
}

/** Seam around subprocess execution that platform stores talk to. */
export interface CommandRunner {
  exec(file: string, args: string[], options?: { input?: string }): Promise<CommandRunnerResult>
}

/**
 * Default runner using `node:child_process`. Passwords travel only through
 * stdin so they never appear in the process argument list.
 */
export class NodeCommandRunner implements CommandRunner {
  exec(
    file: string,
    args: string[],
    options: { input?: string } = {},
  ): Promise<CommandRunnerResult> {
    return new Promise<CommandRunnerResult>((resolve) => {
      const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }))
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      if (options.input !== undefined) {
        child.stdin.write(options.input)
      }
      child.stdin.end()
    })
  }
}

/** In-memory implementation for tests and unsupported platforms. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>()

  async get(key: CredentialKey): Promise<string | null> {
    return this.values.get(compoundKey(key)) ?? null
  }

  async set(key: CredentialKey, value: string): Promise<void> {
    this.values.set(compoundKey(key), value)
  }

  async delete(key: CredentialKey): Promise<void> {
    this.values.delete(compoundKey(key))
  }
}

/**
 * Windows Credential Manager implementation.
 *
 * Why PowerShell `ProtectedData` (DPAPI) and not `cmdkey`: `cmdkey` can add,
 * list and delete generic credentials, but its `/list` output deliberately
 * hides the stored password — a CredentialStore that must support `get()`
 * cannot be built on it. DPAPI (`System.Security.Cryptography.ProtectedData`)
 * encrypts the value with the current Windows user's machine key, the blob is
 * stored on disk in the Skillbox home, and only that user can decrypt it.
 * Tokens are transported to PowerShell over stdin.
 */
export class WindowsCredentialStore implements CredentialStore {
  private readonly runner: CommandRunner
  private readonly secretsDir: string

  constructor(options: { runner?: CommandRunner; secretsDir: string }) {
    this.runner = options.runner ?? new NodeCommandRunner()
    this.secretsDir = options.secretsDir
  }

  async get(key: CredentialKey): Promise<string | null> {
    const file = this.pathFor(key)
    try {
      await fs.stat(file)
    } catch {
      return null
    }
    const result = await this.runner.exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      decodeScript(file),
    ])
    if (result.code !== 0) {
      throw this.storeUnavailable('decrypt', result)
    }
    const base64 = result.stdout.trim()
    if (base64.length === 0) {
      return null
    }
    return Buffer.from(base64, 'base64').toString('utf8')
  }

  async set(key: CredentialKey, value: string): Promise<void> {
    const file = this.pathFor(key)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const base64 = Buffer.from(value, 'utf8').toString('base64')
    const result = await this.runner.exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', protectScript(file)],
      { input: base64 },
    )
    if (result.code !== 0) {
      throw this.storeUnavailable('encrypt', result)
    }
  }

  async delete(key: CredentialKey): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true }).catch(() => undefined)
  }

  private pathFor(key: CredentialKey): string {
    return path.join(this.secretsDir, `${slug(key.service)}__${slug(key.account)}.enc`)
  }

  private storeUnavailable(operation: string, result: CommandRunnerResult): GitHubError {
    return new GitHubError(
      GitHubErrorCode.CREDENTIAL_STORE_UNAVAILABLE,
      `Windows Credential Manager unavailable during "${operation}"`,
      {
        reason: 'store',
        recoverable: true,
        context: { operation, exitCode: result.code, stderr: scrubText(result.stderr) },
      },
    )
  }
}

/**
 * macOS Keychain implementation via `security` (MVP_TASKS §111C).
 * `add-generic-password -w` reads the value from stdin; `find-generic-password
 * -w` prints only the password; `delete-generic-password` removes the entry.
 */
export class MacKeychainCredentialStore implements CredentialStore {
  private readonly runner: CommandRunner

  constructor(options: { runner?: CommandRunner } = {}) {
    this.runner = options.runner ?? new NodeCommandRunner()
  }

  async get(key: CredentialKey): Promise<string | null> {
    const result = await this.runner.exec('security', [
      'find-generic-password',
      '-s',
      key.service,
      '-a',
      key.account,
      '-w',
    ])
    if (result.code !== 0) {
      if (result.code === 44 || result.stderr.toLowerCase().includes('could not be found')) {
        return null
      }
      throw this.storeUnavailable('find', result)
    }
    const value = stripLineBreak(result.stdout)
    return value.length === 0 ? null : value
  }

  async set(key: CredentialKey, value: string): Promise<void> {
    const result = await this.runner.exec(
      'security',
      ['add-generic-password', '-U', '-s', key.service, '-a', key.account, '-w'],
      { input: value },
    )
    if (result.code !== 0) {
      throw this.storeUnavailable('add', result)
    }
  }

  async delete(key: CredentialKey): Promise<void> {
    const result = await this.runner.exec('security', [
      'delete-generic-password',
      '-s',
      key.service,
      '-a',
      key.account,
    ])
    if (result.code !== 0 && !result.stderr.toLowerCase().includes('could not be found')) {
      throw this.storeUnavailable('delete', result)
    }
  }

  private storeUnavailable(operation: string, result: CommandRunnerResult): GitHubError {
    return new GitHubError(
      GitHubErrorCode.CREDENTIAL_STORE_UNAVAILABLE,
      `macOS Keychain unavailable during "${operation}"`,
      {
        reason: 'store',
        recoverable: true,
        context: { operation, exitCode: result.code, stderr: scrubText(result.stderr) },
      },
    )
  }
}

/**
 * Linux Secret Service implementation via `secret-tool` (libsecret CLI).
 * `store` reads the value from stdin; `lookup` prints it; `clear` deletes.
 * When the Secret Service daemon is not running (`--unlock` / DBus failure),
 * a typed error is raised so the CLI can explain how to fix it.
 */
export class LinuxSecretServiceCredentialStore implements CredentialStore {
  private readonly runner: CommandRunner

  constructor(options: { runner?: CommandRunner } = {}) {
    this.runner = options.runner ?? new NodeCommandRunner()
  }

  async get(key: CredentialKey): Promise<string | null> {
    const result = await this.runner.exec('secret-tool', [
      'lookup',
      'service',
      key.service,
      'account',
      key.account,
    ])
    if (result.code !== 0) {
      throw this.storeUnavailable('lookup', result)
    }
    const value = stripLineBreak(result.stdout)
    return value.length === 0 ? null : value
  }

  async set(key: CredentialKey, value: string): Promise<void> {
    const result = await this.runner.exec(
      'secret-tool',
      ['store', '--label', 'skillbox', 'service', key.service, 'account', key.account],
      { input: value },
    )
    if (result.code !== 0) {
      throw this.storeUnavailable('store', result)
    }
  }

  async delete(key: CredentialKey): Promise<void> {
    const result = await this.runner.exec('secret-tool', [
      'clear',
      'service',
      key.service,
      'account',
      key.account,
    ])
    if (result.code !== 0) {
      throw this.storeUnavailable('clear', result)
    }
  }

  private storeUnavailable(operation: string, result: CommandRunnerResult): GitHubError {
    return new GitHubError(
      GitHubErrorCode.CREDENTIAL_STORE_UNAVAILABLE,
      `Linux Secret Service unavailable during "${operation}"`,
      {
        reason: 'store',
        recoverable: true,
        context: { operation, exitCode: result.code, stderr: scrubText(result.stderr) },
      },
    )
  }
}

export interface CredentialStoreFactoryOptions {
  runner?: CommandRunner
  /** Directory for the Windows DPAPI blob store. */
  secretsDir?: string
  platform?: NodeJS.Platform
}

/** Picks the platform-native CredentialStore (falls back to the in-memory one). */
export function createCredentialStore(
  options: CredentialStoreFactoryOptions = {},
): CredentialStore {
  const platform = options.platform ?? process.platform
  switch (platform) {
    case 'win32': {
      const windowsOptions: { runner?: CommandRunner; secretsDir: string } = {
        secretsDir: options.secretsDir ?? defaultWindowsSecretsDirPath(),
      }
      if (options.runner !== undefined) {
        windowsOptions.runner = options.runner
      }
      return new WindowsCredentialStore(windowsOptions)
    }
    case 'darwin': {
      const macOptions: { runner?: CommandRunner } = {}
      if (options.runner !== undefined) {
        macOptions.runner = options.runner
      }
      return new MacKeychainCredentialStore(macOptions)
    }
    case 'linux': {
      const linuxOptions: { runner?: CommandRunner } = {}
      if (options.runner !== undefined) {
        linuxOptions.runner = options.runner
      }
      return new LinuxSecretServiceCredentialStore(linuxOptions)
    }
    default:
      return new MemoryCredentialStore()
  }
}

/** `~/.skillbox/state/secrets` by default. */
function defaultWindowsSecretsDirPath(): string {
  return path.join(os.homedir(), '.skillbox', 'state', 'secrets')
}

function compoundKey(key: CredentialKey): string {
  return `${key.service}/${key.account}`
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

function stripLineBreak(value: string): string {
  return value.replace(/\r?\n$/, '')
}

function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}

function protectScript(file: string): string {
  const target = psQuote(file)
  return (
    'Add-Type -AssemblyName System.Security; ' +
    `$s = [Console]::In.ReadToEnd(); ` +
    `$data = [Convert]::FromBase64String($s.Trim()); ` +
    `$enc = [System.Security.Cryptography.ProtectedData]::Protect($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[IO.File]::WriteAllBytes('${target}', $enc)`
  )
}

function decodeScript(file: string): string {
  const target = psQuote(file)
  return (
    'Add-Type -AssemblyName System.Security; ' +
    `$enc = [IO.File]::ReadAllBytes('${target}'); ` +
    `$data = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Convert]::ToBase64String($data)`
  )
}
