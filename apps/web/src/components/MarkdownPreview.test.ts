import { describe, expect, it } from 'vitest'
import { renderBlocks } from './MarkdownPreview.js'

describe('renderBlocks', () => {
  // Regression: the heading branch once continued without advancing the line
  // index, looping forever on the first `# ` line and OOM-ing the tab.
  it('advances past every heading instead of looping forever', () => {
    const source = [
      '# Alpha',
      '',
      'paragraph one',
      '## Beta',
      '- item a',
      '- item b',
      '### Gamma',
      '```',
      'code',
      '```',
      '> quoted',
      '',
      '---',
    ].join('\n')

    const blocks = renderBlocks(source)
    // 8 blocks: heading, paragraph, heading, list, heading, code, quote, hr
    expect(blocks.length).toBe(8)
  })

  it('renders headings at the demoted level with their inline content', () => {
    const blocks = renderBlocks('# Title with *emphasis*')
    expect(blocks.length).toBe(1)
    const heading = blocks[0] as { type: string }
    expect(heading.type).toBe('h2')
  })

  it('returns no blocks for an empty document', () => {
    expect(renderBlocks('')).toEqual([])
    expect(renderBlocks('\n\n  \n')).toEqual([])
  })
})
