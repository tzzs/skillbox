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
 *   - workspace:* deps  (@skillbox/core) must be published as a real version
 *                       first: the publish order is core -> cli
 *
 * These are *decisions*, not content defects: they do not fail the script,
 * they are reported so a release can make an informed call.
 *
 * What *does* fail the script, beyond missing content, is the published surface
 * being inconsistent with `@skillbox/shared` being `private: true`:
 *
 *   - no `.d.ts` in the tarball and no `"types"` advertised (the emitted
 *     declarations import the private package, so shipping them would break
 *     every consumer that type-checks against `@skillbox/cli`)
 *   - no shipped JS that imports a private workspace package at runtime (that
 *     is not a type warning, it is `Cannot find package` in the user's process)
 *
 * Exit codes: 0 when the tarball is publishable, 1 otherwise.
 */
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
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

/* ---- published surface: `@skillbox/shared` is workspace-private ---- */

/**
 * Workspace packages npm will never see. `@skillbox/cli` may import their
 * *types* while building (they are devDependencies here), but nothing it
 * publishes — a `.d.ts` that mentions them, or a `.js` that imports them at
 * runtime — can survive an install from the registry.
 */
async function privateWorkspacePackages() {
  const names = []
  for (const group of ['packages', 'apps']) {
    for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }
      const manifest = JSON.parse(
        await readFile(join(root, group, entry.name, 'package.json'), 'utf8'),
      )
      if (manifest.private === true && typeof manifest.name === 'string') {
        names.push(manifest.name)
      }
    }
  }
  return names
}

const privatePackages = await privateWorkspacePackages()

console.log('\npublished surface:')
ok =
  required(
    'no .d.ts / .d.ts.map shipped — @skillbox/cli advertises no types',
    ![...paths].some((p) => p.endsWith('.d.ts') || p.endsWith('.d.ts.map')),
  ) && ok
ok = required('package.json has no "types" field', cliPackage.types === undefined) && ok

const referencing = []
for (const packedPath of [...paths].filter((p) => p.endsWith('.js'))) {
  const content = await readFile(join(cliDir, packedPath), 'utf8')
  // An import, not a mention: `contract.test.ts` keeps '@skillbox/shared' as a
  // string constant on purpose, and that would be a false alarm here.
  const imports = /(?:from|import|require)\s*\(?\s*['"`](@skillbox\/[^'"`]+)/g
  const hits = privatePackages.filter((name) => {
    for (const match of content.matchAll(imports)) {
      if (match[1] === name || match[1].startsWith(`${name}/`)) {
        return true
      }
    }
    return false
  })
  if (hits.length > 0) {
    referencing.push(`${packedPath} → ${hits.join(', ')}`)
  }
}
ok =
  required(
    `no shipped JS imports a private workspace package (${privatePackages.join(', ') || 'none'})`,
    referencing.length === 0,
  ) && ok
for (const line of referencing) {
  console.error(`     ${line}`)
}

if (!ok) {
  console.error('\n✗  the published surface would break an npm install of @skillbox/cli.')
  console.error('   A private workspace package cannot be referenced by anything shipped: keep its')
  console.error('   use type-only (`import type`), and keep `.d.ts` out of the tarball until')
  console.error('   either it gets published or those declarations stop referencing it.')
  process.exit(1)
}

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
