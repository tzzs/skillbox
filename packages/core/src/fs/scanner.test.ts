import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { scanSkillDirectory, scanDirectory } from './scanner.js'
import { SkillboxIgnore } from '../ignore/skillbox-ignore.js'
import { withTempDir } from './test-utils.js'

async function createSkillTree(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true })
  await fs.mkdir(path.join(root, 'references', 'deep'), { recursive: true })
  await fs.mkdir(path.join(root, 'assets'), { recursive: true })
  await fs.writeFile(path.join(root, 'SKILL.md'), '# Demo\n')
  await fs.writeFile(path.join(root, 'scripts', 'run.js'), 'console.log(1)')
  await fs.writeFile(path.join(root, 'references', 'deep', 'doc.md'), 'ref')
  await fs.writeFile(path.join(root, 'assets', 'icon.png'), '')
}

describe('scanSkillDirectory', () => {
  it('collects files, directories and total size', async () => {
    await withTempDir(async (root) => {
      await createSkillTree(root)
      const scan = await scanSkillDirectory(root)

      expect(scan.files).toEqual(
        expect.arrayContaining([
          'SKILL.md',
          'scripts/run.js',
          'references/deep/doc.md',
          'assets/icon.png',
        ]),
      )
      expect(scan.directories).toEqual(
        expect.arrayContaining(['scripts', 'references', 'references/deep', 'assets']),
      )
      expect(scan.symlinks).toEqual([])
      expect(scan.totalSize).toBe(
        Buffer.byteLength('# Demo\n') +
          Buffer.byteLength('console.log(1)') +
          Buffer.byteLength('ref'),
      )
    })
  })

  it('returns portable (forward-slash) relative paths', async () => {
    await withTempDir(async (root) => {
      await fs.mkdir(path.join(root, 'sub'), { recursive: true })
      await fs.writeFile(path.join(root, 'sub', 'a.txt'), 'x')
      const scan = await scanSkillDirectory(root)
      expect(scan.files).toContain('sub/a.txt')
      expect(scan.nodes.some((node) => node.relativePath.includes('\\'))).toBe(false)
    })
  })

  it('throws a typed SkillboxFsError for a missing root', async () => {
    await withTempDir(async (root) => {
      await expect(scanSkillDirectory(path.join(root, 'missing'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })
  })

  it('throws for a non-directory root', async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, 'x.txt')
      await fs.writeFile(file, 'x')
      await expect(scanSkillDirectory(file)).rejects.toMatchObject({ code: 'IO_ERROR' })
    })
  })
})

describe('scanSkillDirectory with an ignore matcher', () => {
  it('excludes ignored files and directories from the derived lists', async () => {
    await withTempDir(async (root) => {
      await createSkillTree(root)
      await fs.mkdir(path.join(root, 'secrets'), { recursive: true })
      await fs.writeFile(path.join(root, 'secrets', '.env'), 'TOKEN=x')
      await fs.writeFile(path.join(root, 'prod.key'), 'key material')

      const ignore = SkillboxIgnore.fromText(['secrets/', '*.key'].join('\n'))
      const scan = await scanDirectory(root, { ignore })

      expect(scan.files).not.toContain('secrets/.env')
      expect(scan.files).not.toContain('prod.key')
      expect(scan.files).toContain('SKILL.md')
      expect(scan.directories).not.toContain('secrets')

      // Physical nodes and total size remain untouched (default behavior).
      expect(scan.nodes.some((node) => node.relativePath === 'secrets/.env')).toBe(true)
    })
  })

  it('returns the full tree when no matcher is given (unchanged)', async () => {
    await withTempDir(async (root) => {
      await createSkillTree(root)
      await fs.writeFile(path.join(root, 'skip.key'), 'k')
      const plain = await scanSkillDirectory(root)
      const withEmpty = await scanSkillDirectory(root, { ignore: SkillboxIgnore.empty() })
      expect(withEmpty.files).toEqual(plain.files)
      expect(withEmpty.files).toContain('skip.key')
    })
  })
})
