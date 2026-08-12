#!/usr/bin/env node
/**
 * Packages the built frontend static assets into the web-server package so that
 * `npx skillbox web` serves them without installing the web app separately.
 *
 * The web-server's own `tsc` build emits its modules into the same
 * `packages/web-server/dist/web` directory (`main.js`, `app.js`, ...), so this step
 * only replaces the stale frontend outputs (index.html + hashed assets) and
 * leaves the compiled server code untouched.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'apps', 'web', 'dist')
const target = join(root, 'packages', 'web-server', 'dist', 'web')

await mkdir(target, { recursive: true })
for (const stale of ['index.html', 'assets']) {
  try {
    await rm(join(target, stale), { recursive: true, force: true })
  } catch {
    /* the stale entry may not exist yet */
  }
}
await cp(source, target, { recursive: true })
console.log(`Copied ${source} -> ${target}`)
