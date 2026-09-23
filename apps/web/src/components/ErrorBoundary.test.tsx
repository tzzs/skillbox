import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from './ErrorBoundary.js'

/**
 * Only possible now that apps/web tests get a DOM (`happy-dom`, see
 * `vite.config.ts`): the boundary's whole job is what the user sees *after* a
 * page throws, which no static render can show.
 */
describe('ErrorBoundary (rendered)', () => {
  it('replaces a crashing page with its own UI and renders again on "Try again"', async () => {
    // Spied with the original implementation kept, so every console error still
    // prints; the assertion below is about it happening, not being silenced.
    const consoleError = vi.spyOn(console, 'error')
    const user = userEvent.setup()
    // A flag rather than a render counter: React re-runs the render after an
    // error, so a throw-once child would simply recover on its own.
    const crash = { active: true }
    const CrashingChild = () => {
      if (crash.active) {
        throw new TypeError("Cannot read properties of undefined (reading 'agents')")
      }
      return <p className="page-description">Library rendered again.</p>
    }

    render(
      <ErrorBoundary>
        <CrashingChild />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy()
    // The message the user needs in order to act is the error's own text.
    expect(screen.getByText("Cannot read properties of undefined (reading 'agents')")).toBeTruthy()
    // The crash is reported, not swallowed — by the boundary and by React.
    expect(consoleError).toHaveBeenCalled()
    // ...and the page is still navigable from the fallback.
    expect(screen.getByRole('link', { name: 'Back to Library' }).getAttribute('href')).toBe('/')

    crash.active = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('Library rendered again.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull()
  })
})
