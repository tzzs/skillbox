import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { GitClient } from '../git/index.js'
import { RegistryErrorCode } from './errors.js'
import { GitSourceProvider } from './git.js'
import type { NormalizedSource } from './types.js'

const GIT_SOURCE: NormalizedSource = {
  type: 'git',
  url: 'https://git.example.com/org/repo.git',
}

const GIT_SOURCE_WITH_PATH: NormalizedSource = {
  type: 'git',
  url: 'https://git.example.com/org/repo.git',
  path: 'skills/hello',
  ref: 'main',
}

/** Fake GitClient: ls-remote answers + materialize writes a fake checkout. */
class FakeGit {
  remoteShas: Record<string, string> = {}
  checkout: Record<string, string> = {}
  materialized: Array<{ url: string; targetDir: string; ref?: string }> = []

  async lsRemote(url: string, ref = 'HEAD'): Promise<string | undefined> {
    return this.remoteShas[`${url}#${ref}`]
  }

  async materialize(input: { url: string; targetDir: string; ref?: string }): Promise<void> {
    this.materialized.push(input)
    await fs.mkdir(input.targetDir, { recursive: true })
    for (const [relative, content] of Object.entries(this.checkout)) {
      const target = path.join(input.targetDir, ...relative.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, 'utf8')
    }
  }
}

function providerOf(fake: FakeGit, tmpRoot: string): GitSourceProvider {
  return new GitSourceProvider({ git: fake as unknown as GitClient, tmpRoot })
}

describe('GitSourceProvider', () => {
  it('resolves HEAD to a commit SHA via ls-remote', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      fake.remoteShas['https://git.example.com/org/repo.git#HEAD'] = 'abc123def456'
      const provider = providerOf(fake, dir)

      const resolved = await provider.resolve(GIT_SOURCE)

      expect(resolved.revision).toBe('abc123def456')
    })
  })

  it('resolves a named ref to its current SHA', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      fake.remoteShas['https://git.example.com/org/repo.git#main'] = 'deadbeef1234'
      const provider = providerOf(fake, dir)

      const resolved = await provider.resolve({
        ...GIT_SOURCE,
        ref: 'main',
      })

      expect(resolved.revision).toBe('deadbeef1234')
    })
  })

  it('keeps a pinned full SHA without consulting the remote', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      const provider = providerOf(fake, dir)

      const resolved = await provider.resolve({
        ...GIT_SOURCE,
        ref: '0123456789abcdef0123456789abcdef01234567',
      })

      expect(resolved.revision).toBe('0123456789abcdef0123456789abcdef01234567')
      expect(Object.keys(fake.remoteShas)).toHaveLength(0)
    })
  })

  it('fails with REGISTRY_NOT_FOUND for an unknown ref', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      const provider = providerOf(fake, dir)

      await expect(provider.resolve({ ...GIT_SOURCE, ref: 'nope' })).rejects.toMatchObject({
        code: RegistryErrorCode.REGISTRY_NOT_FOUND,
      })
    })
  })

  it('getLatestRevision reports the remote HEAD', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      fake.remoteShas['https://git.example.com/org/repo.git#HEAD'] = 'latest-sha-1234'
      const provider = providerOf(fake, dir)

      await expect(provider.getLatestRevision(GIT_SOURCE)).resolves.toBe('latest-sha-1234')
    })
  })

  it('downloads the skill subtree of the checkout into the target dir', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      fake.checkout = {
        'skills/hello/SKILL.md': '# hello\n',
        'skills/hello/notes.md': 'subtree\n',
        'skills/other/SKILL.md': '# other\n',
        'README.md': 'repo readme\n',
      }
      const provider = providerOf(fake, dir)
      const target = path.join(dir, 'download')

      await provider.download(GIT_SOURCE_WITH_PATH, 'abc123', target)

      expect(fake.materialized).toEqual([
        {
          url: 'https://git.example.com/org/repo.git',
          targetDir: expect.stringContaining('skillbox-git-'),
          ref: 'abc123',
        },
      ])
      expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('# hello\n')
      expect(await fs.readFile(path.join(target, 'notes.md'), 'utf8')).toBe('subtree\n')
      await expect(fs.stat(path.join(target, 'README.md'))).rejects.toThrow()
      await expect(fs.stat(path.join(target, 'skills'))).rejects.toThrow()
    })
  })

  it('downloads the whole checkout when no source path is given', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      fake.checkout = { 'SKILL.md': '# whole\n', 'README.md': 'repo\n' }
      const provider = providerOf(fake, dir)
      const target = path.join(dir, 'download')

      await provider.download(GIT_SOURCE, 'abc123', target)

      expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('# whole\n')
      expect(await fs.readFile(path.join(target, 'README.md'), 'utf8')).toBe('repo\n')
    })
  })

  it('fails with REGISTRY_NOT_FOUND when the subtree is missing', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      fake.checkout = { 'README.md': 'repo\n' }
      const provider = providerOf(fake, dir)
      const target = path.join(dir, 'download')

      await expect(provider.download(GIT_SOURCE_WITH_PATH, 'abc123', target)).rejects.toMatchObject(
        { code: RegistryErrorCode.REGISTRY_NOT_FOUND },
      )
    })
  })

  it('cleans up the temporary checkout after downloading', async () => {
    await withTempDir(async (dir) => {
      const fake = new FakeGit()
      fake.checkout = { 'SKILL.md': '# x\n' }
      const provider = providerOf(fake, dir)
      const target = path.join(dir, 'download')

      await provider.download(GIT_SOURCE, 'abc123', target)

      // Every temp checkout dir (skillbox-git-*) is gone.
      const entries = await fs.readdir(dir)
      expect(entries.some((name) => name.startsWith('skillbox-git-'))).toBe(false)
    })
  })

  it('search returns no hits (arbitrary git hosts cannot be searched)', async () => {
    await withTempDir(async (dir) => {
      const provider = providerOf(new FakeGit(), dir)
      await expect(provider.search('anything')).resolves.toEqual([])
    })
  })

  it('rejects non-git sources', async () => {
    await withTempDir(async (dir) => {
      const provider = providerOf(new FakeGit(), dir)
      const github: NormalizedSource = { type: 'github', repo: 'acme/skillz' }
      await expect(provider.resolve(github)).rejects.toMatchObject({
        code: RegistryErrorCode.SOURCE_UNSUPPORTED,
      })
      await expect(provider.download(github, 'x', path.join(dir, 't'))).rejects.toMatchObject({
        code: RegistryErrorCode.SOURCE_UNSUPPORTED,
      })
    })
  })
})
