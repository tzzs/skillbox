import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentAdapter } from '../adapter.js'
import { linksSupported } from '../../fs/test-utils.js'

export interface CliAdapterSpec {
  /** Human label used in describe blocks. */
  label: string
  defaultSkillsSubdir: string
  configDirEnv: string
  executableEnv: string
  create: (options: {
    homeDir?: string
    env?: Record<string, string>
    skillsDir?: string
    managedRoot?: string
    searchPath?: boolean
    resolveExecutableInPath?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>
    resolveVersion?: (executable: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  }) => AgentAdapter
}

export async function tempHome(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `skillbox-${name}-`))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

async function writeSkill(root: string, name: string, content = `# ${name}`): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), content)
  return dir
}

export function runCliAdapterSuite(spec: CliAdapterSpec) {
  describe(spec.label, () => {
    it('detects as not found with an empty fixture home', async () => {
      const home = await tempHome('not-detected')
      try {
        const adapter = spec.create({ homeDir: home, searchPath: false })
        const result = await adapter.detect()
        expect(result.detected).toBe(false)
      } finally {
        await cleanup(home)
      }
    })

    it('detects the agent when its skills directory already exists', async () => {
      const home = await tempHome('dir-detected')
      try {
        await mkdir(path.join(home, ...spec.defaultSkillsSubdir.split('/')), { recursive: true })
        const adapter = spec.create({ homeDir: home, searchPath: false })
        const result = await adapter.detect()
        expect(result.detected).toBe(true)
      } finally {
        await cleanup(home)
      }
    })

    it('detects the agent through the executable and reports a version', async () => {
      const home = await tempHome('exec-detected')
      try {
        const executable = path.join(home, 'fake-cli')
        const adapter = spec.create({
          homeDir: home,
          searchPath: false,
          resolveExecutableInPath: async () => executable,
          resolveVersion: async () => '2.0.0',
        })
        const result = await adapter.detect()
        expect(result.detected).toBe(true)
        expect(result.executable).toBe(executable)
        expect(result.version).toBe('2.0.0')
      } finally {
        await cleanup(home)
      }
    })

    it('builds the global skills directory under the fixture home', async () => {
      const home = await tempHome('path')
      try {
        const adapter = spec.create({ homeDir: home, searchPath: false })
        const dirs = await adapter.getSkillDirectories()
        expect(dirs).toEqual([path.join(home, ...spec.defaultSkillsSubdir.split('/'))])
      } finally {
        await cleanup(home)
      }
    })

    it('overrides the skills directory through the config-dir env var', async () => {
      const home = await tempHome('env-path')
      const configDir = path.join(home, 'custom-config')
      try {
        const adapter = spec.create({
          homeDir: home,
          searchPath: false,
          env: { [spec.configDirEnv]: configDir },
        })
        const dirs = await adapter.getSkillDirectories()
        expect(dirs).toEqual([path.join(configDir, 'skills')])
      } finally {
        await cleanup(home)
      }
    })

    it('prefers an explicit skillsDir override over home and env', async () => {
      const home = await tempHome('override')
      const overridden = path.join(home, 'elsewhere', 'skills')
      try {
        const adapter = spec.create({
          homeDir: home,
          searchPath: false,
          skillsDir: overridden,
          env: { [spec.configDirEnv]: path.join(home, 'ignored-config') },
        })
        const dirs = await adapter.getSkillDirectories()
        expect(dirs).toEqual([path.resolve(overridden)])
      } finally {
        await cleanup(home)
      }
    })

    it('scans installed skills and classifies external ones', async () => {
      const home = await tempHome('scan')
      try {
        const skillsRoot = path.join(home, ...spec.defaultSkillsSubdir.split('/'))
        await mkdir(skillsRoot, { recursive: true })
        await writeSkill(skillsRoot, 'external-skill-a')

        const notesFile = path.join(skillsRoot, 'notes.txt')
        await fs.writeFile(notesFile, 'not a skill')

        const adapter = spec.create({
          homeDir: home,
          searchPath: false,
          managedRoot: path.join(home, 'library'),
        })
        const skills = await adapter.scanSkills()
        const names = skills.map((skill) => skill.name)
        expect(names).toContain('external-skill-a')
        expect(names).not.toContain('notes.txt')

        const external = skills.find((skill) => skill.name === 'external-skill-a')
        expect(external?.managedBySkillbox).toBe(false)
      } finally {
        await cleanup(home)
      }
    })

    it.skipIf(!linksSupported)('scans and marks a Skillbox-owned link as managed', async () => {
      const home = await tempHome('scan-owned')
      try {
        const skillsRoot = path.join(home, ...spec.defaultSkillsSubdir.split('/'))
        const library = path.join(home, 'library')
        await mkdir(skillsRoot, { recursive: true })
        await mkdir(library, { recursive: true })
        const source = await writeSkill(library, 'managed-by-lib')

        const adapter = spec.create({
          homeDir: home,
          searchPath: false,
          managedRoot: library,
        })
        await adapter.linkSkill(source)
        const skills = await adapter.scanSkills()
        const managed = skills.find((skill) => skill.name === 'managed-by-lib')
        expect(managed?.managedBySkillbox).toBe(true)
        expect(skills.filter((skill) => skill.managedBySkillbox)).toHaveLength(1)
      } finally {
        await cleanup(home)
      }
    })

    it.skipIf(!linksSupported)(
      'links a managed skill into the agent skills directory',
      async () => {
        const home = await tempHome('link')
        try {
          const skillsRoot = path.join(home, ...spec.defaultSkillsSubdir.split('/'))
          const library = path.join(home, 'library')
          await mkdir(skillsRoot, { recursive: true })
          await mkdir(library, { recursive: true })
          const source = await writeSkill(library, 'linked-skill')

          const adapter = spec.create({
            homeDir: home,
            searchPath: false,
            managedRoot: library,
          })
          await expect(adapter.linkSkill(source)).resolves.toBeUndefined()

          const skills = await adapter.scanSkills()
          expect(skills).toContainEqual(
            expect.objectContaining({ name: 'linked-skill', managedBySkillbox: true }),
          )
        } finally {
          await cleanup(home)
        }
      },
    )

    it.skipIf(!linksSupported)('unlinks a managed skill', async () => {
      const home = await tempHome('unlink')
      try {
        const skillsRoot = path.join(home, ...spec.defaultSkillsSubdir.split('/'))
        const library = path.join(home, 'library')
        await mkdir(skillsRoot, { recursive: true })
        await mkdir(library, { recursive: true })
        const source = await writeSkill(library, 'to-remove')

        const adapter = spec.create({
          homeDir: home,
          searchPath: false,
          managedRoot: library,
        })
        await adapter.linkSkill(source)
        const result = await adapter.unlinkSkill('to-remove')
        expect(result.removed).toBe(true)
        expect(result.reason).toBe('managed')
        expect(
          await fs
            .stat(path.join(skillsRoot, 'to-remove'))
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
      } finally {
        await cleanup(home)
      }
    })

    it('refuses to unlink an external skill and preserves it on disk', async () => {
      const home = await tempHome('external')
      try {
        const skillsRoot = path.join(home, ...spec.defaultSkillsSubdir.split('/'))
        await mkdir(skillsRoot, { recursive: true })
        const external = await writeSkill(skillsRoot, 'personal-skill')

        const adapter = spec.create({
          homeDir: home,
          searchPath: false,
          managedRoot: path.join(home, 'library'),
        })
        const result = await adapter.unlinkSkill('personal-skill')
        expect(result.removed).toBe(false)
        expect(result.reason).toBe('external')
        expect(await fs.readFile(path.join(external, 'SKILL.md'), 'utf8')).toBe('# personal-skill')
      } finally {
        await cleanup(home)
      }
    })

    it('keeps scanning external skills after a failed unlink attempt', async () => {
      const home = await tempHome('external-persist')
      try {
        const skillsRoot = path.join(home, ...spec.defaultSkillsSubdir.split('/'))
        await mkdir(skillsRoot, { recursive: true })
        await writeSkill(skillsRoot, 'keep-me')

        const adapter = spec.create({
          homeDir: home,
          searchPath: false,
        })
        await adapter.unlinkSkill('keep-me')
        const skills = await adapter.scanSkills()
        expect(skills).toContainEqual(expect.objectContaining({ name: 'keep-me' }))

        const kept = skills.find((skill) => skill.name === 'keep-me')
        expect(kept?.managedBySkillbox).toBe(false)
      } finally {
        await cleanup(home)
      }
    })
  })
}
