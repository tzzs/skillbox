import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * M11 frontend build. `outDir` stays at the default `dist/` so the
 * `scripts/package-web.mjs` step can copy it into the CLI package
 * (`packages/cli/dist/web`).
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
