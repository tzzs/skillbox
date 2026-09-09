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

  it('rejects empty hosts and skill directory entries', () => {
    expect(() => runtimeConfigSchema.parse({ web: { host: '   ' } })).toThrow()
    expect(() =>
      runtimeConfigSchema.parse({ agents: { claude: { skillDirectories: ['/ok', ''] } } }),
    ).toThrow()
  })
})
