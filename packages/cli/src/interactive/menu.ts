export const MAIN_MENU_ITEMS = [
  { value: 'my-skills', label: 'My Skills' },
  { value: 'agents', label: 'Agents' },
  { value: 'import', label: 'Import Existing Skills' },
  { value: 'create', label: 'Create Skill' },
  { value: 'web', label: 'Open Web UI' },
  { value: 'settings', label: 'Settings' },
  { value: 'exit', label: 'Exit' },
] as const

export type MainMenuValue = (typeof MAIN_MENU_ITEMS)[number]['value']

export interface MenuOption<T extends string = string> {
  value: T
  label: string
  hint?: string
}

/** Special value used to go back one level inside sub-menus. */
export const BACK = '__back__'

/** Main Menu items with dynamic, context-aware hints (M9.2). */
export function buildMainMenuItems(
  skillCount: number,
  agentCount: number,
): readonly MenuOption<MainMenuValue>[] {
  return MAIN_MENU_ITEMS.map((item) => {
    switch (item.value) {
      case 'my-skills':
        return { ...item, hint: `${skillCount} skill${skillCount === 1 ? '' : 's'}` }
      case 'agents':
        return { ...item, hint: `${agentCount} agent${agentCount === 1 ? '' : 's'}` }
      case 'import':
        return { ...item, hint: 'bring existing agent skills under management' }
      case 'create':
        return { ...item, hint: 'scaffold a new skill from a template' }
      case 'web':
        return { ...item, hint: 'placeholder - coming soon' }
      case 'settings':
        return { ...item, hint: '' }
      default:
        return { ...item, hint: 'quit Skillbox' }
    }
  })
}

/** One main-menu option with an explicit Back entry appended. */
export function withBackOption<T extends string>(
  options: readonly MenuOption<T>[],
): readonly MenuOption<T | typeof BACK>[] {
  return [...options, { value: BACK, label: 'Back' }]
}

/** Action options shown in the Skill detail view (M9.6). */
export type SkillActionValue = 'edit' | 'toggle' | 'remove' | 'back'

export function buildSkillDetailActions(
  enabledAgentCount: number,
): readonly MenuOption<SkillActionValue>[] {
  return [
    { value: 'edit', label: 'Edit', hint: 'open SKILL.md in your editor' },
    {
      value: 'toggle',
      label: 'Enable/Disable',
      hint: `${enabledAgentCount} agent${enabledAgentCount === 1 ? '' : 's'} currently subscribed`,
    },
    { value: 'remove', label: 'Remove', hint: 'remove from your library' },
    { value: 'back', label: 'Back' },
  ]
}

/** Options for the per-agent toggle sub-menu. */
export function buildAgentToggleOptions(
  agents: readonly { id: string; name: string }[],
  enabledIds: readonly string[],
): readonly MenuOption[] {
  const options = agents.map((agent) => {
    const enabled = enabledIds.includes(agent.id)
    return {
      value: `${agent.id}:${enabled ? 'disable' : 'enable'}`,
      label: `${enabled ? 'Disable' : 'Enable'} ${agent.name}`,
      hint: enabled ? 'currently enabled' : 'currently disabled',
    }
  })
  return withBackOption(options)
}

/** Parses an `agentId:enable|disable` toggle value. */
export function parseToggleValue(
  value: string,
): { agent: string; action: 'enable' | 'disable' } | null {
  const separator = value.lastIndexOf(':')
  if (separator <= 0) {
    return null
  }
  const agent = value.slice(0, separator)
  const action = value.slice(separator + 1)
  return action === 'enable' || action === 'disable' ? { agent, action } : null
}
