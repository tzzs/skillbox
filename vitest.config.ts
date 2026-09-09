import { defineConfig } from 'vitest/config'

/** Shared timeout for subprocess and git-backed acceptance journeys. */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
