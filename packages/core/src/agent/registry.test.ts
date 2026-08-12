import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentRegistry, createDefaultAgentRegistry } from './registry.js'
import { ClaudeAdapter } from './adapters/claude.js'
import { CodexAdapter } from './adapters/codex.js'
import { linksSupported } from '../fs/test-utils.js'

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'skillbox-registry-'))
}

async function writeSkill(root: string, name: string): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

describe('AgentRegistry', () => {
  it('registers, gets and lists adapters', () => {
    const registry = new AgentRegistry()
    const claude = new ClaudeAdapter()
    const codex = new CodexAdapter()
    registry.register(claude).register(codex)
    expect(registry.get('claude')).toBe(claude)
    expect(registry.get('codex')).toBe(codex)
    expect(registry.get('missing')).toBeUndefined()
    expect(registry.list()).toEqual([claude, codex])
  })

  it('replaces an adapter with the same id on re-register', () => {
    const registry = new AgentRegistry()
    const first = new ClaudeAdapter()
    const second = new ClaudeAdapter()
    registry.register(first)
    registry.register(second)
    expect(registry.get('claude')).toBe(second)
    expect(registry.list()).toHaveLength(1)
  })

  it('pre-registers the first-party adapters', () => {
    const registry = createDefaultAgentRegistry()
    expect(
      registry
        .list()
        .map((adapter) => adapter.id)
        .sort(),
    ).toEqual(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'windsurf'])
  })

  it('reports undetected agents with a zero skill count', async () => {
    const home = await tempHome()
    try {
      const registry = new AgentRegistry([new ClaudeAdapter({ homeDir: home, searchPath: false })])
      const results = await registry.detectAll()
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ id: 'claude', detected: false, skillCount: 0 })
    } finally {
      await rmTemp(home)
    }
  })

  it('reports detected agents with installed skill counts', async () => {
    const home = await tempHome()
    try {
      const skillsRoot = path.join(home, '.claude', 'skills')
      await mkdir(skillsRoot, { recursive: true })
      await writeSkill(skillsRoot, 'external-a')

      const registry = new AgentRegistry([new ClaudeAdapter({ homeDir: home, searchPath: false })])
      const results = await registry.detectAll()
      expect(results[0]).toMatchObject({
        id: 'claude',
        detected: true,
        skillCount: 1,
        externalSkillCount: 1,
      })
    } finally {
      await rmTemp(home)
    }
  })

  it.skipIf(!linksSupported)('separates managed and external skill counts', async () => {
    const home = await tempHome()
    try {
      const skillsRoot = path.join(home, '.claude', 'skills')
      const library = path.join(home, 'library')
      await mkdir(skillsRoot, { recursive: true })
      await mkdir(library, { recursive: true })
      await writeSkill(library, 'managed-skill')
      await writeSkill(skillsRoot, 'external-skill')

      const adapter = new ClaudeAdapter({ homeDir: home, managedRoot: library, searchPath: false })
      await adapter.linkSkill(path.join(library, 'managed-skill'))

      const registry = new AgentRegistry([adapter])
      const [result] = await registry.detectAll()
      expect(result).toMatchObject({
        id: 'claude',
        detected: true,
        skillCount: 2,
        managedSkillCount: 1,
        externalSkillCount: 1,
      })
    } finally {
      await rmTemp(home)
    }
  })

  it('keeps going when an adapter fails during detection', async () => {
    const registry = new AgentRegistry()
    registry.register(
      new ClaudeAdapter({ homeDir: 'Z:/definitely/does-not-exist', searchPath: false }),
    )
    const failing: Parameters<AgentRegistry['register']>[0] = {
      id: 'broken',
      name: 'Broken',
      capabilities: {
        supportsGlobalSkills: true,
        supportsProjectSkills: false,
        supportsSymlinks: false,
        supportsNestedSkillDirectories: false,
        requiresRestartAfterChange: false,
      },
      async detect() {
        throw new Error('boom')
      },
      async getSkillDirectories() {
        return []
      },
      async scanSkills() {
        return []
      },
      async linkSkill() {},
      async unlinkSkill() {
        return { name: '', path: '', removed: false, reason: 'managed' as const }
      },
    }
    registry.register(failing)
    const results = await registry.detectAll()
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.id === 'broken')).toMatchObject({ detected: false, skillCount: 0 })
    expect(results.find((r) => r.id === 'claude')).toBeDefined()
  })
})

async function rmTemp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
