import { describe, expect, it } from 'vitest'
import {
  BACK,
  buildAgentToggleOptions,
  buildMainMenuItems,
  buildSkillDetailActions,
  MAIN_MENU_ITEMS,
  parseToggleValue,
  withBackOption,
} from './menu.js'

describe('buildMainMenuItems', () => {
  it('returns one option per main-menu entry', () => {
    const items = buildMainMenuItems(3, 2)
    expect(items).toHaveLength(MAIN_MENU_ITEMS.length)
    expect(items.map((item) => item.value)).toEqual([
      'my-skills',
      'agents',
      'import',
      'create',
      'web',
      'settings',
      'exit',
    ])
  })

  it('labels each option with the M9 names', () => {
    const items = buildMainMenuItems(0, 0)
    expect(items.map((item) => item.label)).toEqual([
      'My Skills',
      'Agents',
      'Import Existing Skills',
      'Create Skill',
      'Open Web UI',
      'Settings',
      'Exit',
    ])
  })

  it('adds the skill count to My Skills', () => {
    const items = buildMainMenuItems(12, 0)
    expect(items.find((item) => item.value === 'my-skills')?.hint).toBe('12 skills')
  })

  it('adds the agent count to Agents', () => {
    const items = buildMainMenuItems(0, 2)
    expect(items.find((item) => item.value === 'agents')?.hint).toBe('2 agents')
  })
})

describe('withBackOption', () => {
  it('appends a Back option', () => {
    const options = withBackOption([{ value: 'a', label: 'A' }])
    expect(options).toEqual([
      { value: 'a', label: 'A' },
      { value: BACK, label: 'Back' },
    ])
  })
})

describe('buildSkillDetailActions', () => {
  it('includes the four M9.6 actions', () => {
    const actions = buildSkillDetailActions(2)
    expect(actions.map((action) => action.value)).toEqual(['edit', 'toggle', 'remove', 'back'])
  })

  it('keeps the agent-count hint correct for zero agents', () => {
    const actions = buildSkillDetailActions(0)
    expect(actions[1]?.hint).toBe('0 agents currently subscribed')
  })
})

describe('buildAgentToggleOptions', () => {
  it('offers enable for disabled agents and disable for enabled ones', () => {
    const options = buildAgentToggleOptions(
      [
        { id: 'claude', name: 'Claude' },
        { id: 'codex', name: 'Codex' },
      ],
      ['claude'],
    )
    expect(options.map((option) => option.label)).toEqual([
      'Disable Claude',
      'Enable Codex',
      'Back',
    ])
  })
})

describe('parseToggleValue', () => {
  it('parses agent:action values', () => {
    expect(parseToggleValue('claude:enable')).toEqual({ agent: 'claude', action: 'enable' })
    expect(parseToggleValue('codex:disable')).toEqual({ agent: 'codex', action: 'disable' })
  })

  it('rejects malformed values', () => {
    expect(parseToggleValue('no-colon')).toBeNull()
    expect(parseToggleValue(':enable')).toBeNull()
    expect(parseToggleValue('claude:unknown')).toBeNull()
  })
})
