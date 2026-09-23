import { defineConfig } from 'vitest/config'

/**
 * Component tests for the web UI.
 *
 * Kept separate from `vite.config.ts` (which vitest then ignores — see the note
 * there about the two vite versions). Nothing from the build config is needed
 * here: the tests import page and component modules directly, esbuild handles
 * the JSX, and no CSS or alias resolution is involved.
 */
export default defineConfig({
  test: {
    /* This package is the browser UI, so its tests get a real DOM and can render
     * and click components. happy-dom over jsdom: faster startup and a smaller
     * transitive tree, and nothing here needs jsdom-only behaviour. Scoped to
     * apps/web — the other workspace packages keep the `node` default. */
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
