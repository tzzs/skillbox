import { describe, expect, it } from 'vitest'
import { reportProblems } from './report.js'

describe('reportProblems', () => {
  it('writes one line per problem, with the alias only when there is one', () => {
    const chunks: string[] = []
    reportProblems(
      (chunk) => chunks.push(chunk),
      [
        {
          code: 'SKILL_MISSING',
          alias: 'ghost',
          message: 'Local skill directory missing: /repo/ghost',
        },
        { code: 'INVALID_MANIFEST', message: 'skills.demo: source must have a type' },
      ],
    )
    expect(chunks).toEqual([
      '  SKILL_MISSING ghost: Local skill directory missing: /repo/ghost\n',
      '  INVALID_MANIFEST: skills.demo: source must have a type\n',
    ])
  })

  it('writes nothing when there is no problem', () => {
    const chunks: string[] = []
    reportProblems((chunk) => chunks.push(chunk), [])
    expect(chunks).toEqual([])
  })
})
