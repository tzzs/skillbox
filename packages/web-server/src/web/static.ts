import * as path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { Context } from 'hono'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

/**
 * Maps a URL path to a file inside `root`. Path traversal (`/..`, absolute or
 * backslash escapes) is rejected. The empty path resolves to `index.html`.
 */
export function resolveStaticPath(root: string, urlPath: string): string | undefined {
  let relative: string
  try {
    relative = decodeURIComponent(urlPath).replace(/^\/+/, '').replace(/\\/g, '/')
  } catch {
    return undefined
  }
  if (relative.length === 0) {
    return path.join(root, 'index.html')
  }
  const candidate = path.resolve(root, relative)
  const rootResolved = path.resolve(root)
  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${path.sep}`)) {
    return undefined
  }
  return candidate
}

/** True when the client asks for an HTML document (SPA navigation). */
export function isHtmlNavigation(c: Context): boolean {
  return (c.req.header('accept') ?? '').includes('text/html')
}

/** Reads a file (following a directory to its `index.html`) or returns undefined. */
async function readFileOrNothing(
  filePath: string,
): Promise<{ data: Buffer; mime: string } | undefined> {
  let target = filePath
  try {
    let info = await stat(target)
    if (info.isDirectory()) {
      target = path.join(target, 'index.html')
      info = await stat(target)
    }
  } catch {
    return undefined
  }
  try {
    const data = await readFile(target)
    const ext = path.extname(target).toLowerCase()
    return { data, mime: MIME_TYPES[ext] ?? 'application/octet-stream' }
  } catch {
    return undefined
  }
}

/**
 * Serves the built frontend from `root` (M10.1 / M11.10). Requests that do
 * not map to a file and ask for HTML fall back to `index.html`, so client-side
 * routes such as `/skills/my-skill` work after a refresh.
 */
export function staticHandler(root: string): (c: Context) => Promise<Response> {
  return async (c) => {
    const filePath = resolveStaticPath(root, c.req.path)
    if (filePath !== undefined) {
      const found = await readFileOrNothing(filePath)
      if (found !== undefined) {
        return new Response(found.data, {
          headers: {
            'Content-Type': found.mime,
            'Cache-Control': 'no-cache',
          },
        })
      }
    }

    if (isHtmlNavigation(c)) {
      const indexHtml = await readFileOrNothing(path.join(root, 'index.html'))
      if (indexHtml !== undefined) {
        return new Response(indexHtml.data, {
          headers: { 'Content-Type': indexHtml.mime, 'Cache-Control': 'no-cache' },
        })
      }
    }

    return c.text('Not Found', 404)
  }
}
