import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError, type OutdatedSkill } from '../api.js'
import { BatchFailureList, runBatchUpdates, type BatchState } from './UpdatesPage.js'

/** What the server actually answers for a `safe`-policy refusal of a high-risk revision. */
const blocked = new ApiError(
  403,
  'INSTALL_SECURITY_BLOCKED',
  'Security scan rated github:acme/shell-guard high risk (2 finding(s)); retry with allow-all',
  true,
)

function row(name: string, overrides: Partial<OutdatedSkill> = {}): OutdatedSkill {
  return {
    name,
    source: `github:acme/${name}`,
    installed: 'a1b2c3d4e5f6',
    latest: 'b7c8d9e0f1a2',
    changes: [],
    agents: ['claude'],
    ...overrides,
  }
}

const noop = (): void => undefined

describe('runBatchUpdates', () => {
  it('keeps the reason of every failed row instead of only a count', async () => {
    const final = await runBatchUpdates(
      [row('alpha'), row('shell-guard'), row('beta')],
      async (target) => {
        if (target.name === 'shell-guard') {
          throw blocked
        }
        return { name: target.name }
      },
      noop,
    )

    expect(final).toEqual({
      done: 3,
      total: 3,
      failed: 1,
      failures: [{ name: 'shell-guard', reason: blocked.message }],
    })
  })

  it('does not abort the batch on the first rejection', async () => {
    const attempted: string[] = []
    await runBatchUpdates(
      [row('alpha'), row('beta'), row('gamma')],
      async (target) => {
        attempted.push(target.name)
        if (attempted.length === 1) {
          throw new TypeError('Failed to fetch')
        }
        return {}
      },
      noop,
    )
    expect(attempted).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('reports a transport failure with its own message, since no API envelope exists', async () => {
    const final = await runBatchUpdates(
      [row('alpha')],
      async () => {
        throw new TypeError('Failed to fetch')
      },
      noop,
    )
    expect(final.failures).toEqual([{ name: 'alpha', reason: 'Failed to fetch' }])
  })

  it('publishes one state per row so the counter moves while the batch runs', async () => {
    const states: BatchState[] = []
    await runBatchUpdates(
      [row('alpha'), row('beta')],
      async () => ({}),
      (state) => states.push(state),
    )
    expect(states.map((state) => `${state.done}/${state.total} failed=${state.failed}`)).toEqual([
      '0/2 failed=0',
      '1/2 failed=0',
      '2/2 failed=0',
    ])
  })
})

describe('BatchFailureList', () => {
  it('renders one line per failed skill with the reason the API gave', () => {
    const html = renderToStaticMarkup(
      <BatchFailureList failures={[{ name: 'shell-guard', reason: blocked.message }]} />,
    )
    expect(html).toContain('finding-list')
    expect(html).toContain('role="status"')
    expect(html).toContain('shell-guard')
    expect(html).toContain('2 finding(s)')
  })

  it('renders nothing when every row updated', () => {
    expect(renderToStaticMarkup(<BatchFailureList failures={[]} />)).toBe('')
  })
})
