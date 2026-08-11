import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { SkillboxIgnore } from '../ignore/skillbox-ignore.js'
import { findingKey, SecretPolicyStore } from './policy.js'
import { scanFiles } from './scanner.js'

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
}

describe('scanFiles - file-level patterns', () => {
  it('flags sensitive filenames and blocks the scan', async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, {
        '.env': 'DATABASE_URL=postgres://localhost/db\n',
        'certs/cert.pem': '-----BEGIN CERTIFICATE-----\n',
        '.ssh/id_rsa': 'ssh key material\n',
      })
      const result = await scanFiles(['.env', 'certs/cert.pem', '.ssh/id_rsa'], { root })

      expect(result.block).toBe(true)
      const ids = result.findings.map((finding) => finding.patternId)
      expect(ids).toContain('dotenv-file')
      expect(ids).toContain('private-key-file')
      expect(ids).toContain('ssh-private-key')
      expect(result.blocked.some((finding) => finding.patternId === 'private-key-file')).toBe(true)
    })
  })

  it('leaves safe files clean', async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, { 'SKILL.md': '# hello\n', 'scripts/run.js': 'console.log(1)\n' })
      const result = await scanFiles(['SKILL.md', 'scripts/run.js'], { root })
      expect(result.block).toBe(false)
      expect(result.findings).toEqual([])
    })
  })
})

describe('scanFiles - content patterns and severity', () => {
  it('detects API keys, github tokens and private key blocks (high/critical)', async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, {
        'config.js': [
          "const gh = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'",
          "const oa = 'sk-proj-1234567890abcdefghijklmnopqrstuv'",
          "const aws = 'AKIAIOSFODNN7EXAMPLE'",
          '-----BEGIN PRIVATE KEY-----',
          '-----END PRIVATE KEY-----',
          '',
        ].join('\n'),
      })
      const result = await scanFiles(['config.js'], { root })

      expect(result.block).toBe(true)
      const ids = result.blocked.map((finding) => finding.patternId)
      expect(ids).toContain('github-pat')
      expect(ids).toContain('openai-api-key')
      expect(ids).toContain('aws-access-key')
      expect(ids).toContain('private-key-block')

      const privateKey = result.blocked.find((finding) => finding.patternId === 'private-key-block')
      expect(privateKey?.line).toBe(4)
      expect(privateKey?.severity).toBe('critical')
      expect(privateKey?.snippet).not.toContain('PRIVATE KEY')
    })
  })

  it('reports bearer tokens as warnings and placeholders as info', async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, {
        'notes.md': [
          'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
          "password = 'xxx'",
          '',
        ].join('\n'),
      })
      const result = await scanFiles(['notes.md'], { root })

      expect(result.block).toBe(false)
      expect(result.warnings.map((finding) => finding.patternId)).toEqual(['generic-bearer'])
      expect(result.infos.map((finding) => finding.patternId)).toEqual(['credential-placeholder'])
    })
  })

  it('does not emit snippets with the real secret', async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, { 'a.js': "const t='ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'\n" })
      const result = await scanFiles(['a.js'], { root })
      const finding = result.findings[0]
      expect(finding?.snippet).not.toContain('ghp_ABCD')
      expect(finding?.snippet).toContain('***')
    })
  })
})

describe('scanFiles - ignore and policy wiring', () => {
  it('skips files matched by the scan scope of .skillboxignore', async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, {
        'secrets/token.txt': 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef\n',
        'keep.js': 'const t="ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"\n',
      })
      const ignore = SkillboxIgnore.fromText('scan: secrets/\n')
      const result = await scanFiles(['secrets/token.txt', 'keep.js'], { root, ignore })

      expect(result.skippedByIgnore).toContain('secrets/token.txt')
      expect(result.blocked.some((finding) => finding.file === 'secrets/token.txt')).toBe(false)
      expect(result.blocked.some((finding) => finding.file === 'keep.js')).toBe(true)
    })
  })

  it('honours policy decisions (ignore once and add to ignore)', async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, { 'a.js': 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef\n' })
      const policyPath = path.join(root, 'state', 'secret-policy.json')
      const policy = new SecretPolicyStore({ filePath: policyPath })

      const first = await scanFiles(['a.js'], { root, policy })
      expect(first.block).toBe(true)
      const firstFinding = first.blocked[0]!
      const key = findingKey(firstFinding.file, firstFinding.line, firstFinding.patternId)

      policy.ignoreOnce([key])
      const afterOnce = await scanFiles(['a.js'], { root, policy })
      expect(afterOnce.block).toBe(false)
      expect(afterOnce.skippedByPolicy).toContain(key)

      policy.clearSession()
      const afterClear = await scanFiles(['a.js'], { root, policy })
      expect(afterClear.block).toBe(true)

      await policy.addIgnoredPattern(firstFinding.patternId)
      const afterPersisted = await scanFiles(['a.js'], { root, policy })
      expect(afterPersisted.block).toBe(false)

      const persisted = new SecretPolicyStore({ filePath: policyPath })
      await persisted.load()
      expect(persisted.snapshot?.ignoredPatterns).toContain(firstFinding.patternId)
    })
  })

  it('skips binary content, size caps and missing files without throwing', async () => {
    await withTempDir(async (root) => {
      const binary = Buffer.from([0x00, 0x01, 0x02, 0x03])
      await writeFiles(root, {
        'blob.bin': '',
        'big.js': 'x',
      })
      await fs.writeFile(path.join(root, 'blob.bin'), binary)
      await fs.writeFile(path.join(root, 'big.js'), 'a'.repeat(100))

      const result = await scanFiles(['blob.bin', 'big.js', 'missing.js'], {
        root,
        maxContentBytes: 10,
      })
      expect(result.block).toBe(false)
      expect(result.findings).toEqual([])
    })
  })
})
