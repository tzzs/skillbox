import type { SkillStatusEntry } from '@skillbox/core'

export type TuiPage = 'overview' | 'skills' | 'agents' | 'detail'

export interface TuiAgentSummary {
  id: string
  name: string
  detected: boolean
  skillCount: number
}

export interface TuiViewModel {
  page: TuiPage
  selected: number
  skills: readonly SkillStatusEntry[]
  agents: readonly TuiAgentSummary[]
  notice?: string
}

function selectedPrefix(index: number, selected: number): string {
  return index === selected ? '›' : ' '
}

function status(value: SkillStatusEntry): string {
  return `${value.status}${value.mode === 'managed' ? '' : ` · ${value.mode}`}`
}

/** Renders the content that is placed in the terminal alternate screen. */
export function renderFullscreen(model: TuiViewModel): string {
  const header = ['Skillbox', '═'.repeat(68)]
  const footer = '[↑↓] Navigate  [Enter] Skills  [S] Sync  [C] Create  [A] Agents  [Q] Quit'
  let body: string[]

  if (model.page === 'agents') {
    body = [
      'Agents',
      '',
      ...(model.agents.length === 0
        ? ['  No registered agents']
        : model.agents.map(
            (agent, index) =>
              `${selectedPrefix(index, model.selected)} ${agent.name}  ${agent.detected ? 'detected' : 'not found'}  ${agent.skillCount} skills`,
          )),
      '',
      '[Esc] Back',
    ]
  } else if (model.page === 'detail') {
    const skill = model.skills[model.selected]
    body =
      skill === undefined
        ? ['Skill not found', '', '[Esc] Back']
        : [
            `Skill · ${skill.name}`,
            '',
            `Mode:    ${skill.mode}`,
            `Status:  ${skill.status}`,
            `Agents:  ${skill.agents.length === 0 ? 'none' : skill.agents.join(', ')}`,
            ...(skill.message === undefined ? [] : [`Notice:  ${skill.message}`]),
            '',
            '[E] Enable  [D] Disable  [X] Remove  [Esc] Back',
          ]
  } else {
    const title = model.page === 'overview' ? 'Overview' : 'Managed skills'
    body = [
      title,
      '',
      `${model.skills.length} managed skills · ${model.agents.filter((agent) => agent.detected).length} detected agents`,
      '',
      ...(model.skills.length === 0
        ? ['  No managed skills. Press C to create one.']
        : model.skills.map(
            (skill, index) =>
              `${selectedPrefix(index, model.selected)} ${skill.name.padEnd(28)} ${status(skill)}`,
          )),
      '',
      model.page === 'overview' ? '[Enter] Skills' : '[Enter] View skill  [Esc] Back',
    ]
  }

  return [
    ...header,
    '',
    ...body,
    ...(model.notice === undefined ? [] : ['', `• ${model.notice}`]),
    '',
    '─'.repeat(68),
    footer,
  ].join('\n')
}
