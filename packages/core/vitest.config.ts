import { defineConfig } from 'vitest/config'

/**
 * Core test defaults. Several suites run real transactions over a slow
 * filesystem (WSL / Windows runners); the vitest 5s default can flake there
 * (see GAP_ANALYSIS §9.2, roadmap 3.3 flaky-test policy). A 15s bound keeps
 * real hangs visible while absorbing slow-but-valid work.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
