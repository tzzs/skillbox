import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { ApiError, type InstallInput, type InstallResult, type OutdatedSkill } from '../api.js'
import {
  BatchFailureList,
  UpdatesPage,
  runBatchUpdates,
  type BatchFailure,
  type BatchState,
} from './UpdatesPage.js'

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

/**
 * Helpers for the rendered flow tests below: the rendered "Update all" flow is
 * the part the helper-level tests above cannot reach — the button, the confirm
 * dialog, and the reason actually landing on screen. It needs a DOM, so it runs
 * in the `happy-dom` environment configured in `vite.config.ts` rather than the
 * `node` default the rest of this file is happy with.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installed(name: string): InstallResult {
  return {
    name,
    source: `github:acme/${name}`,
    revision: 'b7c8d9e0f1a2',
    path: `/repo/skills/${name}`,
    security: { risk: 'low', findings: [] },
    agents: ['claude'],
    manifestChanged: true,
    lockfileChanged: true,
  }
}

/**
 * Stubs the two routes the Updates page touches. `shell-guard` keeps answering
 * with the security refusal, everything else installs — so the batch has one
 * failure *with a reason* and one success to compare it against.
 */
function stubRegistryApi(): void {
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/registry/outdated') {
      return jsonResponse({
        outdated: [row('alpha'), row('shell-guard', { securityRisk: 'high' })],
      })
    }
    if (path === '/api/registry/install') {
      const body = JSON.parse(String(init?.body ?? '{}')) as InstallInput
      const name = body.source.replace('github:acme/', '')
      if (name === 'shell-guard') {
        return jsonResponse(
          {
            error: {
              code: blocked.code,
              message: blocked.message,
              recoverable: blocked.recoverable,
            },
          },
          blocked.status,
        )
      }
      return jsonResponse({ installed: installed(name) })
    }
    throw new Error(`Updates page fetched an unstubbed route: ${path}`)
  })
  vi.stubGlobal('fetch', fetchStub)
}

function renderUpdatesPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/updates']}>
        <UpdatesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('UpdatesPage "Update all" (rendered)', () => {
  it('clicking the button puts the failing skill and its API reason on screen', async () => {
    // Spied without a mock implementation: a real console error both prints and
    // fails the test below, so nothing reaches the author only via stderr noise.
    const consoleError = vi.spyOn(console, 'error')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    stubRegistryApi()
    const user = userEvent.setup()
    renderUpdatesPage()

    await user.click(await screen.findByRole('button', { name: 'Update all' }))

    // (a) the reason is the server's own envelope message, verbatim.
    const reason = await screen.findByText(blocked.message)

    // The failure list is the aria-live region the component comment promises:
    // one polite container holding every row that failed.
    const live = screen.getByRole('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.contains(reason)).toBe(true)

    // (b) the row that updated is not listed as failed — the list holds exactly
    // the one refusal, and the summary counts the survivor as updated.
    const failedRows = within(live).getAllByRole('listitem')
    expect(failedRows.map((entry) => entry.textContent)).toEqual([`shell-guard${blocked.message}`])
    expect(within(live).queryByText('alpha')).toBeNull()
    expect(screen.getByText(/^Batch finished — 1 updated, 1 skipped or failed\.$/)).toBeTruthy()

    // The batch ran through the `safe` policy the confirm dialog described.
    expect(confirm).toHaveBeenCalledWith(
      'Update all 2 skill(s)? 1 high-risk revision(s) will be skipped by the safety policy.',
    )
    // (c) and the flow got there quietly: no React/query error output.
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('aborts the batch when the confirm dialog is declined', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/registry/outdated') {
        return jsonResponse({ outdated: [row('alpha')] })
      }
      throw new Error(`Updates page fetched an unstubbed route: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchStub)
    const user = userEvent.setup()
    renderUpdatesPage()

    await user.click(await screen.findByRole('button', { name: 'Update all' }))

    expect(confirm).toHaveBeenCalledWith('Update all 1 skill(s)?')
    expect(
      fetchStub.mock.calls.filter(([input]) => String(input) === '/api/registry/install'),
    ).toHaveLength(0)
    expect(screen.queryByRole('status')).toBeNull()
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('BatchFailureList as a live region', () => {
  it('appends later failures into the same container instead of replacing it', () => {
    const first: BatchFailure = { name: 'shell-guard', reason: blocked.message }
    const second: BatchFailure = { name: 'nightly-trainer', reason: 'git: connection reset' }
    const { getByRole, rerender } = render(<BatchFailureList failures={[first]} />)

    const region = getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')

    rerender(<BatchFailureList failures={[first, second]} />)

    // Re-mounting the region would drop the announcement — assistive tech only
    // reports changes made *inside* the node it registered as live, which is
    // why the second failure has to arrive in the element from the first run.
    expect(getByRole('status')).toBe(region)
    // Every row still names its own skill *and* the reason it failed.
    const rows = within(region).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain(first.name)
    expect(rows[0]?.textContent).toContain(first.reason)
    expect(rows[1]?.textContent).toContain(second.name)
    expect(rows[1]?.textContent).toContain(second.reason)
  })
})
