import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { emptySecretPolicy, findingKey, SecretPolicyStore } from './policy.js'

async function policyPath(root: string): Promise<string> {
  const dir = path.join(root, 'state')
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, 'secret-policy.json')
}

describe('SecretPolicyStore', () => {
  it('loads an empty policy when the file is missing', async () => {
    await withTempDir(async (root) => {
      const store = new SecretPolicyStore({ filePath: await policyPath(root) })
      const policy = await store.load()
      expect(policy).toEqual(emptySecretPolicy())
    })
  })

  it('persists add-to-ignore decisions and reloads them from disk', async () => {
    await withTempDir(async (root) => {
      const filePath = await policyPath(root)
      const store = new SecretPolicyStore({ filePath })
      await store.addIgnoredPattern('github-pat')
      await store.addIgnoredFile('config.js')
      await store.addIgnoredFinding('config.js:3:openai-api-key')

      const reloaded = new SecretPolicyStore({ filePath })
      const policy = await reloaded.load()
      expect(policy.ignoredPatterns).toEqual(['github-pat'])
      expect(policy.ignoredFiles).toEqual(['config.js'])
      expect(policy.ignoredFindings).toEqual(['config.js:3:openai-api-key'])
    })
  })

  it('is idempotent when re-adding the same decision', async () => {
    await withTempDir(async (root) => {
      const store = new SecretPolicyStore({ filePath: await policyPath(root) })
      await store.addIgnoredPattern('aws-access-key')
      await store.addIgnoredPattern('aws-access-key')
      expect(store.snapshot?.ignoredPatterns).toEqual(['aws-access-key'])
    })
  })

  it('keep ignore-once decisions in the session only', async () => {
    await withTempDir(async (root) => {
      const store = new SecretPolicyStore({ filePath: await policyPath(root) })
      const key = findingKey('secrets/x.env', 1, 'dotenv-file')
      expect(store.shouldSkip(key, 'dotenv-file', 'secrets/x.env')).toBe(false)

      store.ignoreOnce([key])
      expect(store.shouldSkip(key, 'dotenv-file', 'secrets/x.env')).toBe(true)

      store.clearSession()
      expect(store.shouldSkip(key, 'dotenv-file', 'secrets/x.env')).toBe(false)
    })
  })

  it('checks persisted patterns, findings and file globs', async () => {
    await withTempDir(async (root) => {
      const store = new SecretPolicyStore({ filePath: await policyPath(root) })
      await store.addIgnoredPattern('github-pat')
      await store.addIgnoredFinding('a.js:2:openai-api-key')
      await store.addIgnoredFile('secrets/')

      expect(store.shouldSkip('a.js:1:github-pat', 'github-pat', 'a.js')).toBe(true)
      expect(store.isIgnoredFile('secrets/token.txt')).toBe(true)
      expect(
        store.shouldSkip('secrets/deep/x:1:aws-access-key', 'aws-access-key', 'secrets/deep/x'),
      ).toBe(true)
      expect(store.shouldSkip('other.js:2:openai-api-key', 'openai-api-key', 'other.js')).toBe(
        false,
      )
      expect(store.shouldSkip('a.js:1:aws-access-key', 'aws-access-key', 'a.js')).toBe(false)
    })
  })

  it('throws INVALID_CONFIG on a malformed policy file', async () => {
    await withTempDir(async (root) => {
      const filePath = await policyPath(root)
      await fs.writeFile(filePath, '{ not json', 'utf8')
      const store = new SecretPolicyStore({ filePath })
      await expect(store.load()).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    })
  })
})
