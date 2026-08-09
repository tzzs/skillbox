import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { SkillboxIgnore } from '../ignore/skillbox-ignore.js'
import { computeSkillIntegrity } from './canonical-hash.js'

async function writeRoot(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
}

describe('computeSkillIntegrity + .skillboxignore', () => {
  it('excludes files matched by .skillboxignore from the hash (SPEC §109)', async () => {
    await withTempDir(async (root) => {
      const withKey = path.join(root, 'with-key')
      const withoutKey = path.join(root, 'without-key')
      await fs.mkdir(withKey)
      await fs.mkdir(withoutKey)

      const base = {
        'SKILL.md': '# demo\n',
        'notes/a.md': 'a\n',
        '.skillboxignore': '*.key\n',
      }
      await writeRoot(withKey, { ...base, 'secret.key': '-----BEGIN PRIVATE KEY-----\n' })
      await writeRoot(withoutKey, base)

      // Same tree except for an ignored file -> identical integrity.
      expect(await computeSkillIntegrity(withKey)).toBe(await computeSkillIntegrity(withoutKey))

      // And a different file outgrows the ignore -> integrity changes.
      await writeRoot(withKey, { ...base, 'notes/extra.md': 'x\n' })
      expect(await computeSkillIntegrity(withKey)).not.toBe(await computeSkillIntegrity(withoutKey))
    })
  })

  it('honours directory patterns in the ignore file', async () => {
    await withTempDir(async (root) => {
      const withSecrets = path.join(root, 'with-secrets')
      const withoutSecrets = path.join(root, 'without-secrets')
      await fs.mkdir(withSecrets)
      await fs.mkdir(withoutSecrets)

      const base = {
        'SKILL.md': '# demo\n',
        '.skillboxignore': 'secrets/\n*.key\n',
      }
      await writeRoot(withSecrets, {
        ...base,
        'secrets/db.env': 'TOKEN=secret\n',
        'secret.key': 'x',
      })
      await writeRoot(withoutSecrets, base)

      expect(await computeSkillIntegrity(withSecrets)).toBe(
        await computeSkillIntegrity(withoutSecrets),
      )
    })
  })

  it('auto-loads .skillboxignore within computeSkillIntegrity', async () => {
    await withTempDir(async (root) => {
      const skill = path.join(root, 'skill')
      const onlySkill = path.join(root, 'only-skill')
      await fs.mkdir(skill)
      await fs.mkdir(onlySkill)

      // Both trees carry the same `.skillboxignore` file (which is
      // repository-owned and therefore part of the hash).
      await writeRoot(skill, {
        'SKILL.md': '# demo\n',
        'cert.pem': 'x',
        '.skillboxignore': '*.pem\n',
      })
      await writeRoot(onlySkill, { 'SKILL.md': '# demo\n', '.skillboxignore': '*.pem\n' })

      expect(await computeSkillIntegrity(skill)).toBe(await computeSkillIntegrity(onlySkill))
    })
  })

  it('keeps previous behavior when no .skillboxignore exists', async () => {
    await withTempDir(async (root) => {
      const skill = path.join(root, 'skill')
      await fs.mkdir(skill)
      await fs.writeFile(path.join(skill, 'SKILL.md'), '# demo\n', 'utf8')

      const withExplicitEmpty = await computeSkillIntegrity(skill, {
        ignore: SkillboxIgnore.empty(),
      })
      expect(await computeSkillIntegrity(skill)).toBe(withExplicitEmpty)
    })
  })
})
