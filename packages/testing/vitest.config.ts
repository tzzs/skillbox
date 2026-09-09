import { defineConfig } from 'vitest/config'

/**
 * Testing-package defaults. The E2E journeys spawn the packaged CLI as a real
 * subprocess (Node boot + commander + core import); on slow machines a single
 * invocation can exceed the vitest 5s default, so the suite runs with a
 * generous timeout instead of flaking (roadmap 3.3 flaky-test policy).
 */
export default defineConfig({
  test: {
    // Each journey spawns the CLI several times (Node boot + commander +
    // core import ≈ 5s per invocation on slow machines); a full journey can
    // reach 40-50s, so the suite runs with a generous bound instead of
    // flaking (roadmap 3.3 flaky-test policy).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
