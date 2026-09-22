import { Fragment, type ReactNode } from 'react'

/**
 * A deliberately small, dependency-free Markdown renderer for read-only skill
 * previews. It supports the subset SKILL.md files actually use — ATX headings,
 * fenced/inline code, ordered/unordered lists, blockquotes, horizontal rules,
 * links, and bold/italic — and renders everything as React nodes. Raw HTML is
 * never injected (text goes through React's escaping), so a hostile skill file
 * cannot execute script or exfiltrate via the preview. Anything it doesn't
 * recognise is shown as a plain paragraph, which is safe and legible.
 */
export function MarkdownPreview({ source }: { source: string }) {
  return <div className="markdown">{renderBlocks(source)}</div>
}

/** Exported for regression tests (the heading branch once looped forever). */
export function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0

  while (index < lines.length) {
    const line = lines[index] as string

    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = /^```/.exec(line)
    if (fence !== null) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index] as string)) {
        code.push(lines[index] as string)
        index += 1
      }
      index += 1 // consume the closing fence
      blocks.push(
        <pre key={key++} className="markdown__code">
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = (heading[1] as string).length
      const content = renderInline(heading[2] as string)
      const Tag = `h${Math.min(level + 1, 6)}` as 'h2'
      blocks.push(<Tag key={key++}>{content}</Tag>)
      index += 1
      continue
    }

    if (/^(\s*[-*+]\s+)+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] as string)) {
        const item = (/^\s*[-*+]\s+(.*)$/.exec(lines[index] as string) ?? [])[1] ?? ''
        items.push(<li key={items.length}>{renderInline(item)}</li>)
        index += 1
      }
      blocks.push(
        <ul key={key++} className="markdown__list">
          {items}
        </ul>,
      )
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] as string)) {
        const item = (/^\s*\d+\.\s+(.*)$/.exec(lines[index] as string) ?? [])[1] ?? ''
        items.push(<li key={items.length}>{renderInline(item)}</li>)
        index += 1
      }
      blocks.push(
        <ol key={key++} className="markdown__list">
          {items}
        </ol>,
      )
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index] as string)) {
        quote.push((lines[index] as string).replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(
        <blockquote key={key++} className="markdown__quote">
          {renderInline(quote.join(' '))}
        </blockquote>,
      )
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} />)
      index += 1
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      (lines[index] as string).trim() !== '' &&
      !/^```/.test(lines[index] as string) &&
      !/^(#{1,6})\s+/.test(lines[index] as string) &&
      !/^\s*[-*+]\s+/.test(lines[index] as string) &&
      !/^\s*\d+\.\s+/.test(lines[index] as string) &&
      !/^>\s?/.test(lines[index] as string)
    ) {
      paragraph.push(lines[index] as string)
      index += 1
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(' '))}</p>)
  }

  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let counter = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > last) {
      nodes.push(<Fragment key={counter++}>{text.slice(last, start)}</Fragment>)
    }
    nodes.push(<Fragment key={counter++}>{renderToken(match[0])}</Fragment>)
    last = start + match[0].length
  }
  if (last < text.length) {
    nodes.push(<Fragment key={counter++}>{text.slice(last)}</Fragment>)
  }
  return nodes
}

function renderToken(token: string): ReactNode {
  if (token.startsWith('**') || token.startsWith('__')) {
    return <strong>{token.slice(2, -2)}</strong>
  }
  if (token.startsWith('*') || token.startsWith('_')) {
    return <em>{token.slice(1, -1)}</em>
  }
  if (token.startsWith('`')) {
    return <code className="markdown__inline-code">{token.slice(1, -1)}</code>
  }
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
  if (link !== null) {
    const href = link[2] as string
    // Skill files are third-party content, so only web/mail schemes may become
    // links; anything else (javascript:, data:) stays literal text.
    if (!/^(https?:|mailto:|\/|#|\.)/i.test(href)) {
      return token
    }
    const external = /^https?:/i.test(href)
    return (
      <a href={href} rel={external ? 'noreferrer noopener' : undefined}>
        {link[1]}
      </a>
    )
  }
  return token
}
