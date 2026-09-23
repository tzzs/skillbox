import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * M11 frontend build. `outDir` stays at the default `dist/` so the
 * `scripts/package-web.mjs` step can copy it into the CLI package
 * (`packages/cli/dist/web`).
 *
 * Test config lives in `vitest.config.ts`, not in a `test` block here: this app
 * builds against vite 6 while `vitest/config` re-exports vite 7's types, and the
 * two `Plugin` types are not interchangeable under `exactOptionalPropertyTypes`,
 * so typing `plugins: [react()]` through vitest's `defineConfig` fails to
 * compile. A separate config keeps each file against one vite.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:43821',
    },
  },
})
