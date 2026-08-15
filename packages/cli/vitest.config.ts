import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@skillbox/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@skillbox/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // The lifecycle wiring tests execute the real `main()` with full DI; on
    // slow machines a single case can take 2–6.5s, tripping the vitest 5s
    // default (GAP_ANALYSIS §9.2, roadmap 3.3 flaky-test policy). A 15s bound
    // keeps real hangs visible while absorbing slow-but-valid work.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
