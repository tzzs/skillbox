import { describe, expect, it } from 'vitest'
import { renderFullscreen } from './view.js'
import type { TuiAgentSummary } from './view.js'

const agent: TuiAgentSummary = {
  id: 'claude',
  name: 'Claude Code',
  detected: true,
  skillCount: 1,
}

describe('renderFullscreen', () => {
  it('renders a full-screen overview with daily workflow shortcuts', () => {
    const output = renderFullscreen({
      page: 'overview',
      selected: 0,
      skills: [
        { name: 'review', mode: 'managed', status: 'ready', agents: ['claude'] },
        { name: 'release', mode: 'forked', status: 'modified', agents: [] },
      ],
      agents: [agent],
    })

    expect(output).toContain('Skillbox')
    expect(output).toContain('2 managed skills')
    expect(output).toContain('[S] Sync')
    expect(output).toContain('[C] Create')
    expect(output).toContain('[Enter] Skills')
  })

  it('renders a selected skill detail with mutation shortcuts', () => {
    const output = renderFullscreen({
      page: 'detail',
      selected: 0,
      skills: [{ name: 'review', mode: 'managed', status: 'ready', agents: ['claude'] }],
      agents: [agent],
    })

    expect(output).toContain('review')
    expect(output).toContain('[E] Enable')
    expect(output).toContain('[D] Disable')
    expect(output).toContain('[X] Remove')
  })
})
