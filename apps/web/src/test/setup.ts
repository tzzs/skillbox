import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

/**
 * Load path for every apps/web test file (see `test.setupFiles` in
 * `vite.config.ts`).
 *
 * React Testing Library renders into `document.body` and leaves the DOM
 * behind, so without this the second test in a file would still see the first
 * test's markup and `getByText` would match the wrong render.
 */
afterEach(() => {
  cleanup()
  // Drops `vi.stubGlobal` fetch/confirm mocks so a test can't leak its stub
  // into the next one, and restores spies (including the console ones).
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
