#!/usr/bin/env node
/**
 * Installs the three packed workspace packages into a fresh directory and
 * executes the installed `skillbox` binary. This is deliberately an npm
 * consumer test: it catches missing package files, broken bin metadata, and
 * unresolved workspace dependencies without publishing anything.
 *
 * Run `pnpm build` first. The script only consumes the release artefacts; it
 * never substitutes source directories for packed dependencies.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packages = ['@skillbox/shared', '@skillbox/core', '@skillbox/cli']
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const sandbox = await mkdtemp(join(tmpdir(), 'skillbox-pack-smoke-'))
const tarballs = join(sandbox, 'tarballs')
const consumer = join(sandbox, 'consumer')
const npmCache = join(sandbox, 'npm-cache')

function run(command, args, cwd) {
  // Windows command shims (`*.cmd`) cannot be launched with execFileSync.
  // Route through cmd.exe, just as verify-package.mjs does for npm.
  const executable = process.platform === 'win32' ? 'cmd.exe' : command
  const argv = process.platform === 'win32' ? ['/d', '/s', '/c', command, ...args] : args
  return execFileSync(executable, argv, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function packedTarball(packageName) {
  const packageDirectory = packageName.split('/').at(-1)
  const manifest = JSON.parse(
    await readFile(join(root, 'packages', packageDirectory, 'package.json'), 'utf8'),
  )
  return join(tarballs, `${packageName.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)
}

try {
  await Promise.all([mkdir(tarballs), mkdir(consumer)])
  for (const packageName of packages) {
    run(pnpm, ['--filter', packageName, 'pack', '--pack-destination', tarballs], root)
  }

  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'skillbox-pack-smoke', private: true, version: '0.0.0' }),
  )
  const tarballPaths = await Promise.all(packages.map(packedTarball))
  run(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      npmCache,
      ...tarballPaths,
    ],
    consumer,
  )

  const command =
    process.platform === 'win32'
      ? join(consumer, 'node_modules', '.bin', 'skillbox.cmd')
      : join(consumer, 'node_modules', '.bin', 'skillbox')
  const help = run(command, ['--help'], consumer)
  if (!help.includes('Manage the skills your AI agents use.')) {
    throw new Error('Installed skillbox binary did not produce the expected help output.')
  }

  console.log(`✓ packed install smoke passed (${basename(sandbox)})`)
} finally {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
