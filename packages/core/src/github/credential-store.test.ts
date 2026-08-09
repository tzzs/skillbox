import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  LinuxSecretServiceCredentialStore,
  MacKeychainCredentialStore,
  MemoryCredentialStore,
  WindowsCredentialStore,
  createCredentialStore,
} from './credential-store.js'
import type { CommandRunner, CommandRunnerResult, CredentialKey } from './credential-store.js'
import { GitHubErrorCode, isGitHubError } from './errors.js'
import { withTempDir } from '../fs/test-utils.js'

const key: CredentialKey = { service: 'skillbox-github', account: 'oauth-tokens' }

function runner(
  impl: (file: string, args: string[], input?: string) => CommandRunnerResult,
): CommandRunner {
  return {
    exec: (file: string, args: string[], options?: { input?: string }) => {
      return Promise.resolve(impl(file, args, options?.input))
    },
  }
}

function success(stdout = '', stderr = ''): CommandRunnerResult {
  return { code: 0, stdout, stderr }
}

describe('MemoryCredentialStore', () => {
  it('round-trips a value and exposes it via get', async () => {
    const store = new MemoryCredentialStore()
    expect(await store.get(key)).toBeNull()
    await store.set(key, 'ghu_secret')
    expect(await store.get(key)).toBe('ghu_secret')
    await store.delete(key)
    expect(await store.get(key)).toBeNull()
  })

  it('treats missing entries as null and delete as a no-op', async () => {
    const store = new MemoryCredentialStore()
    await store.set({ service: 'other', account: 'entry' }, 'v')
    expect(await store.get(key)).toBeNull()
    await store.delete(key)
    expect(await store.get(key)).toBeNull()
  })
})

describe('WindowsCredentialStore (DPAPI via PowerShell)', () => {
  it('encrypts the value with DPAPI and stores an .enc blob', async () => {
    await withTempDir(async (dir) => {
      let script = ''
      let stdinValue: string | undefined
      const store = new WindowsCredentialStore({
        secretsDir: dir,
        runner: runner((file, args, input) => {
          expect(file).toBe('powershell.exe')
          expect(args[0]).toBe('-NoProfile')
          script = args.at(-1) ?? ''
          stdinValue = input
          return success()
        }),
      })
      await store.set(key, 'ghu_secret')
      expect(script).toContain('ProtectedData')
      expect(script).toContain('CurrentUser')
      expect(script).toContain('[IO.File]::WriteAllBytes')
      expect(stdinValue).toBe(Buffer.from('ghu_secret', 'utf8').toString('base64'))
    })
  })

  it('decrypts the DPAPI blob back to the plaintext value', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox-github__oauth-tokens.enc'), 'encrypted-bytes')
      const store = new WindowsCredentialStore({
        secretsDir: dir,
        runner: runner((_file, args) => {
          const script = args.at(-1) ?? ''
          expect(script).toContain('ProtectedData')
          const encrypted = Buffer.from('ghu_secret', 'utf8').toString('base64')
          return success(`${encrypted}\n`)
        }),
      })
      expect(await store.get(key)).toBe('ghu_secret')
    })
  })

  it('returns null when the blob file is absent', async () => {
    await withTempDir(async (dir) => {
      const store = new WindowsCredentialStore({ secretsDir: dir })
      expect(await store.get(key)).toBeNull()
    })
  })

  it('raises CREDENTIAL_STORE_UNAVAILABLE when decryption fails', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox-github__oauth-tokens.enc'), 'x')
      const store = new WindowsCredentialStore({
        secretsDir: dir,
        runner: runner(() => ({ code: 1, stdout: '', stderr: 'Access denied' })),
      })
      const error = await store.get(key).catch((e: unknown) => e)
      expect(isGitHubError(error)).toBe(true)
      expect((error as { code: string }).code).toBe(GitHubErrorCode.CREDENTIAL_STORE_UNAVAILABLE)
    })
  })

  it('removes the blob on delete regardless of existence', async () => {
    await withTempDir(async (dir) => {
      const blob = path.join(dir, 'skillbox-github__oauth-tokens.enc')
      await fs.writeFile(blob, 'x')
      const store = new WindowsCredentialStore({ secretsDir: dir })
      await store.delete(key)
      await expect(fs.stat(blob)).rejects.toThrow()
    })
  })
})

describe('MacKeychainCredentialStore', () => {
  it('finds a password with the -w flag honoring service and account', async () => {
    const store = new MacKeychainCredentialStore({
      runner: runner((file, args) => {
        expect(file).toBe('security')
        expect(args).toEqual(['find-generic-password', '-s', key.service, '-a', key.account, '-w'])
        return success('ghu_keychain_value\n')
      }),
    })
    expect(await store.get(key)).toBe('ghu_keychain_value')
  })

  it('returns null when the entry cannot be found (exit 44 or message)', async () => {
    const notFound = runner(() => ({ code: 44, stdout: '', stderr: 'could not be found' }))
    const store = new MacKeychainCredentialStore({ runner: notFound })
    expect(await store.get(key)).toBeNull()
    const store2 = new MacKeychainCredentialStore({
      runner: runner(() => ({ code: 1, stdout: '', stderr: 'item could not be found' })),
    })
    expect(await store2.get(key)).toBeNull()
  })

  it('adds the value over stdin so it never appears in argv', async () => {
    let stdinValue: string | undefined
    let argv = ''
    const store = new MacKeychainCredentialStore({
      runner: runner((file, args, input) => {
        expect(file).toBe('security')
        argv = args.join(' ')
        stdinValue = input
        return success()
      }),
    })
    await store.set(key, 'ghu_keychain_value')
    expect(argv).toContain('add-generic-password')
    expect(argv).toBe(`add-generic-password -U -s ${key.service} -a ${key.account} -w`)
    expect(argv).not.toContain('ghu_keychain_value')
    expect(stdinValue).toBe('ghu_keychain_value')
  })

  it('ignores not-found on delete but raises on real failures', async () => {
    const store = new MacKeychainCredentialStore({
      runner: runner(() => ({ code: 1, stdout: '', stderr: 'could not be found' })),
    })
    await store.delete(key)
    const store2 = new MacKeychainCredentialStore({
      runner: runner(() => ({ code: 1, stdout: '', stderr: 'lock failed' })),
    })
    const error = await store2.delete(key).catch((e: unknown) => e)
    expect((error as { code: string }).code).toBe(GitHubErrorCode.CREDENTIAL_STORE_UNAVAILABLE)
  })
})

describe('LinuxSecretServiceCredentialStore', () => {
  it('looks up a stored secret with service/account attributes', async () => {
    const store = new LinuxSecretServiceCredentialStore({
      runner: runner((file, args) => {
        expect(file).toBe('secret-tool')
        expect(args).toEqual(['lookup', 'service', key.service, 'account', key.account])
        return success('ghu_linux_value\n')
      }),
    })
    expect(await store.get(key)).toBe('ghu_linux_value')
  })

  it('returns null on empty lookup output', async () => {
    const store = new LinuxSecretServiceCredentialStore({
      runner: runner((_file, _args) => success('')),
    })
    expect(await store.get(key)).toBeNull()
  })

  it('stores the value via stdin and labels the item', async () => {
    let stdinValue: string | undefined
    let argv = ''
    const store = new LinuxSecretServiceCredentialStore({
      runner: runner((file, args, input) => {
        expect(file).toBe('secret-tool')
        argv = args.join(' ')
        stdinValue = input
        return success()
      }),
    })
    await store.set(key, 'ghu_linux_value')
    expect(argv).toContain('--label')
    expect(argv).not.toContain('ghu_linux_value')
    expect(stdinValue).toBe('ghu_linux_value')
  })

  it('deletes via clear and surfaces failures as store errors', async () => {
    const store = new LinuxSecretServiceCredentialStore({
      runner: runner((_file, args) => {
        expect(args[0]).toBe('clear')
        return success()
      }),
    })
    await store.delete(key)
    const store2 = new LinuxSecretServiceCredentialStore({
      runner: runner(() => ({ code: 2, stdout: '', stderr: 'no secret service' })),
    })
    const error = await store2.get(key).catch((e: unknown) => e)
    expect((error as { code: string }).code).toBe(GitHubErrorCode.CREDENTIAL_STORE_UNAVAILABLE)
  })
})

describe('createCredentialStore', () => {
  it('picks the platform-native store and falls back to memory otherwise', () => {
    expect(createCredentialStore({ platform: 'win32', secretsDir: 'C:/tmp' })).toBeInstanceOf(
      WindowsCredentialStore,
    )
    expect(createCredentialStore({ platform: 'darwin' })).toBeInstanceOf(MacKeychainCredentialStore)
    expect(createCredentialStore({ platform: 'linux' })).toBeInstanceOf(
      LinuxSecretServiceCredentialStore,
    )
    expect(createCredentialStore({ platform: 'freebsd' as NodeJS.Platform })).toBeInstanceOf(
      MemoryCredentialStore,
    )
  })
})
