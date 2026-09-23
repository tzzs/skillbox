import { describe, expect, it } from 'vitest'
import { runtimeConfigSchema, serializeRuntimeConfig } from './config.js'

describe('runtime config schema', () => {
  it('accepts host and multi-directory overrides alongside the legacy path', () => {
    const config = runtimeConfigSchema.parse({
      web: { host: ' 127.0.0.1 ', port: 3000 },
      agents: {
        claude: {
          path: '/home/user/.claude/skills',
          skillDirectories: [' /home/user/.claude/skills ', '/repo/.claude/skills'],
        },
      },
    })

    expect(config.web?.host).toBe('127.0.0.1')
    expect(config.agents?.claude).toEqual({
      path: '/home/user/.claude/skills',
      skillDirectories: ['/home/user/.claude/skills', '/repo/.claude/skills'],
    })
    expect(serializeRuntimeConfig(config)).toContain('"skillDirectories"')
  })

  it('round-trips every field the schema accepts through the serializer', () => {
    const config = runtimeConfigSchema.parse({
      version: 1,
      repository: '/repo',
      linkStrategy: 'symlink',
      web: { port: 4321, host: '127.0.0.1', open: false },
      agents: { claude: { path: '/x/.claude' } },
      library: { autoAdopt: false, ignoreAgents: ['cursor'], ignoreSkills: ['scratch'] },
      github: { connected: true, login: 'tzzs', repository: 'skills' },
    })
    // The serializer rebuilds the document in a fixed key order, so a field it
    // forgets to copy would vanish from `config.json` silently.
    expect(JSON.parse(serializeRuntimeConfig(config))).toEqual(config)
  })

  it('rejects empty hosts and skill directory entries', () => {
    expect(() => runtimeConfigSchema.parse({ web: { host: '   ' } })).toThrow()
    expect(() =>
      runtimeConfigSchema.parse({ agents: { claude: { skillDirectories: ['/ok', ''] } } }),
    ).toThrow()
  })
})
