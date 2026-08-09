#!/usr/bin/env node
/**
 * Verifies the publish shape of @skillbox/cli without publishing anything.
 *
 * Runs `npm pack --dry-run --json` inside packages/cli (an in-memory content
 * listing, no .tgz is written) and asserts the package contains what a user
 * installing `npx skillbox` would need:
 *
 *   - bin/skillbox.mjs          the CLI entry (bin field)
 *   - dist/index.js             compiled CLI coordinator
 *   - dist/web/index.html       M11 frontend entry
 *   - dist/web/assets/*         hashed React/Vite bundles (package-web.mjs output)
 *
 * It also prints the packed size, and flags the two current blockers for a
 * real `npm publish`:
 *
 *   - "private": true   on the package (npm refuses to publish private packs)
 *   - workspace:* deps  (@skillbox/core, @skillbox/shared) must be published
 *                       as real versions in the order shared -> core -> cli
 *
 * These are *decisions*, not content defects: they do not fail the script,
 * they are reported so a release can make an informed call.
 *
 * Exit codes: 0 when the tarball contents are complete, 1 otherwise.
 */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const cliDir = join(root, 'packages', 'cli')
const cliPackageJsonPath = join(cliDir, 'package.json')

function required(path, condition) {
  if (!condition) {
    console.error(`  ✗  ${path}`)
  } else {
    console.log(`  ✓  ${path}`)
  }
  return condition
}

const cliPackage = JSON.parse(await readFile(cliPackageJsonPath, 'utf8'))

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
let listing
try {
  // On Windows *.cmd shims cannot be exec'd directly (EINVAL); route through cmd.exe.
  const argv =
    process.platform === 'win32'
      ? ['/c', 'npm.cmd', 'pack', '--dry-run', '--json']
      : ['pack', '--dry-run', '--json']
  const npmExe = process.platform === 'win32' ? 'cmd.exe' : npmBin
  const stdout = execFileSync(npmExe, argv, {
    cwd: cliDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  listing = JSON.parse(stdout)[0]
} catch {
  console.error('✗  could not run `npm pack --dry-run --json` in packages/cli')
  process.exit(1)
}

console.log(`@skillbox/cli@${listing.version} pack content check (${listing.filename})\n`)

const paths = new Set(listing.files.map((file) => file.path))
let ok = true

console.log('required entries:')
ok = required('bin/skillbox.mjs', paths.has('bin/skillbox.mjs')) && ok
ok = required('dist/index.js', paths.has('dist/index.js')) && ok
ok = required('dist/web/index.html', paths.has('dist/web/index.html')) && ok
ok =
  required(
    'dist/web/assets/*',
    listing.files.some((f) => f.path.startsWith('dist/web/assets/')),
  ) && ok

if (!ok) {
  console.error('\n✗  package contents are incomplete.')
  console.error(
    '   Run `pnpm build` first so dist/ and dist/web/ are fresh (scripts/package-web.mjs).',
  )
  process.exit(1)
}

const assetFiles = listing.files.filter((f) => f.path.startsWith('dist/web/assets/'))
const webBytes = assetFiles.reduce((sum, f) => sum + f.size, 0)
console.log(
  `\nweb static assets: ${assetFiles.length} file(s), ${(webBytes / 1024).toFixed(1)} KiB`,
)

const kb = (listing.unpackedSize / 1024).toFixed(0)
console.log(`packed size:       ${(listing.size / 1024).toFixed(1)} KiB`)
console.log(`unpacked size:     ${kb} KiB (${listing.files.length} files)`)

console.log('\npublish blockers (informational, not a content defect):')
const workspaceDeps = Object.entries(cliPackage.dependencies ?? {})
  .filter(([, range]) => range === 'workspace:*')
  .map(([name]) => name)
if (cliPackage.private === true) {
  console.log('  ⚠  "private": true — npm publish will refuse until it is removed')
  console.log('      (product decision; the gap plan leaves this to the release owner)')
} else {
  console.log('  ✓  "private" not set — publish is possible')
}
if (workspaceDeps.length > 0) {
  console.log(
    `  ⚠  workspace deps must be published as versions in order: ${workspaceDeps.join(' → ')}`,
  )
} else {
  console.log('  ✓  no workspace:* deps')
}

console.log('\n✓  package contents are complete and ready to verify against INSTALLATION.md §3.')
