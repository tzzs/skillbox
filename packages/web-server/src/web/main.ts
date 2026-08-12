import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { createAdaptorServer } from '@hono/node-server'
import type { Server } from 'node:http'
import type { Command } from 'commander'
import { version } from '@skillbox/core'
import { createWebApp } from './app.js'
import { createWebServices } from './services.js'
import type { StartedWebServer, WebServerOptions } from './types.js'

export const DEFAULT_PORT = 43821
export const DEFAULT_HOST = '127.0.0.1'

/**
 * Absolute path of the frontend assets when running from the built CLI
 * (`packages/cli/dist/web`). Present only after `pnpm build`.
 */
export async function defaultStaticDir(): Promise<string | undefined> {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidate = path.resolve(here, '..', 'web')
  try {
    const info = await stat(path.join(candidate, 'index.html'))
    if (info.isFile()) {
      return candidate
    }
  } catch {
    /* the frontend is not built yet */
  }
  return undefined
}

/**
 * M10.1/M10.2 — starts the Web Server (Hono + @hono/node-server). When the
 * requested port is busy (M10.2) it falls back to an ephemeral port. Binding
 * 0.0.0.0 warns that the UI is exposed to the local network (M10.4).
 */
export async function startWebServer(options: WebServerOptions): Promise<StartedWebServer> {
  const out = options.out ?? ((chunk: string) => process.stdout.write(chunk))
  const err = options.err ?? ((chunk: string) => process.stderr.write(chunk))
  const host = options.host ?? DEFAULT_HOST
  const requestedPort = options.port ?? DEFAULT_PORT

  const services = createWebServices({
    repositoryRoot: options.repositoryRoot,
    homeRoot: options.homeRoot,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  })
  if (host === '0.0.0.0') {
    err('Skillbox UI will be exposed to the local network.\n')
  }

  const staticDir = await resolveStaticDir(options.staticDir)
  const app = createWebApp({
    services,
    ...(staticDir === undefined ? {} : { staticDir }),
    info: { name: 'skillbox', version },
  })

  // Random port fallback (M10.2): when the requested port is busy we retry
  // with an ephemeral port; when 0 was requested we use it directly.
  const attempt = async (port: number) => {
    const { server, port: boundPort } = await listen(app, host, port)
    const url = formatUrl(host, boundPort)
    printStart(out, options.open, url, services.homeRoot)
    return { server, port: boundPort, url, close: () => close(server) }
  }

  try {
    return await attempt(requestedPort)
  } catch (error) {
    if (isEaddrinuse(error) && requestedPort !== 0) {
      return await attempt(0)
    }
    throw error
  }
}

type FetchServer = Server

async function listen(
  app: import('hono').Hono,
  host: string,
  port: number,
): Promise<{ server: FetchServer; port: number }> {
  const server = createAdaptorServer({ fetch: app.fetch }) as unknown as FetchServer
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.on('error', onError)
    server.listen(port, host)
    server.once('listening', onListening)
  })
  server.removeAllListeners('error')
  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  return { server, port: boundPort }
}

function formatUrl(host: string, port: number): string {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host
  return `http://${shownHost}:${port}`
}

function printStart(
  out: (chunk: string) => void,
  open: boolean | undefined,
  url: string,
  homeRoot: string,
): void {
  out(`Skillbox web UI: ${url}\n`)
  out(`  home  ${homeRoot}\n`)
  if (open !== false) {
    openBrowser(url)
  }
}

function close(server: FetchServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

/** Opens the default browser when a spawning command exists on the platform. */
function openBrowser(url: string): void {
  const [command, args] = browserCommand(url)
  if (command === undefined) {
    return
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    /* opening the browser is best-effort; the URL is already printed */
  }
}

function browserCommand(url: string): [string, string[]] | [undefined, string[]] {
  if (process.platform === 'win32') {
    return ['cmd', ['/c', 'start', '', url]]
  }
  if (process.platform === 'darwin') {
    return ['open', [url]]
  }
  return ['xdg-open', [url]]
}

function isEaddrinuse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  )
}

async function resolveStaticDir(explicit: string | undefined): Promise<string | undefined> {
  if (explicit !== undefined) {
    return path.resolve(explicit)
  }
  return defaultStaticDir()
}

/**
 * The command-line flags accepted by the `web` subcommand. The actual
 * `startWebServer` invocation lives in the coordinator so the interactive/CLI
 * wiring can stay out of this module.
 */
export function registerWebCommand(program: Command): Command {
  const command = program
    .command('web')
    .description(`Start the Skillbox web UI (default ${DEFAULT_HOST}:${DEFAULT_PORT})`)
    .option('-p, --port <port>', `port to listen on (default ${DEFAULT_PORT}, 0 = random)`)
    .option('--host <host>', `interface to bind (default ${DEFAULT_HOST})`)
    .option('--no-open', 'do not open a browser automatically')
    .option('--repository <path>', 'repository root to manage (default: current directory)')
  return command
}

export type WebCommandFlags = {
  port?: string
  host?: string
  open?: boolean
  repository?: string
}

/**
 * Web server options that can be derived from CLI flags. Every field is
 * optional so the spread in {@link webOptionsFromFlags} stays compatible with
 * `exactOptionalPropertyTypes`.
 */
export type WebOptionsFromFlags = Partial<
  Pick<WebServerOptions, 'port' | 'host' | 'open' | 'repositoryRoot'>
>

/** Converts the parsed `--port`/`--host`/`--repository` flags into server options. */
export function webOptionsFromFlags(flags: WebCommandFlags): WebOptionsFromFlags {
  const portValue = flags.port === undefined || flags.port === '' ? undefined : Number(flags.port)
  return {
    ...(portValue === undefined ? {} : { port: portValue }),
    ...(flags.host === undefined ? {} : { host: flags.host }),
    ...(flags.open === undefined ? {} : { open: flags.open }),
    ...(flags.repository === undefined ? {} : { repositoryRoot: flags.repository }),
  }
}
