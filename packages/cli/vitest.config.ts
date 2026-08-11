import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@skillbox/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@skillbox/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
})
