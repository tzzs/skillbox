import { describe, expect, it } from 'vitest'
import { resolveEditorCommand } from './editor.js'

describe('resolveEditorCommand', () => {
  it('resolves the EDITOR with the file appended', () => {
    const command = resolveEditorCommand('E:/repo/skills/x/SKILL.md', { EDITOR: 'code' })
    expect(command).toEqual({ command: 'code', args: ['E:/repo/skills/x/SKILL.md'] })
  })

  it('splits EDITOR arguments into the command', () => {
    const command = resolveEditorCommand('/repo/SKILL.md', {
      EDITOR: 'vim -n --noplugin',
    })
    expect(command?.command).toBe('vim')
    expect(command?.args).toEqual(['-n', '--noplugin', '/repo/SKILL.md'])
  })

  it('prefers VEDITOR when EDITOR is missing', () => {
    const command = resolveEditorCommand('/repo/SKILL.md', { VISUAL: 'nano' })
    expect(command?.command).toBe('nano')
  })

  it('returns null without an editor configured', () => {
    expect(resolveEditorCommand('/repo/SKILL.md', {})).toBeNull()
  })
})
