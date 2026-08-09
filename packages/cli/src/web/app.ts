import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type {
  AgentsResponse,
  HealthResponse,
  ReconcileResponse,
  SkillResponse,
  SkillsResponse,
  WebAppOptions,
} from './types.js'
import { toApiError, unknownRouteEnvelope, WebApiError } from './errors.js'
import { isHtmlNavigation, staticHandler } from './static.js'

/**
 * M10.6/M10.7 — the JSON API and the static frontend behind the Web Server.
 * All data flows through the Core services in `options.services`; the handlers
 * only shape requests/responses and translate Core errors into M10.8 envelopes.
 */
export function createWebApp(options: WebAppOptions): Hono {
  const { services } = options
  const info = options.info ?? { name: 'skillbox', version: '0.0.0' }
  const staticDir = options.staticDir

  const app = new Hono()

  app.onError((error, c) => {
    const api = toApiError(error)
    return c.json(api.body, toStatusCode(api.status))
  })

  /* ---- read-only API (M10.6) ---- */

  app.get('/api/health', (c) => {
    return c.json<HealthResponse>({
      status: 'ok',
      name: info.name,
      version: info.version,
      repository: services.repositoryRoot,
      home: services.homeRoot,
    })
  })

  app.get('/api/skills', async (c) => {
    const report = await services.status.status()
    return c.json<SkillsResponse>({ skills: report.skills })
  })

  app.get('/api/skills/:id/content', async (c) => {
    const id = c.req.param('id')
    const doc = await services.skills.readSkillMarkdown({ name: id })
    return c.json({ skill: { name: doc.name, path: doc.path, markdown: doc.markdown } })
  })

  app.get('/api/skills/:id', async (c) => {
    const id = c.req.param('id')
    const report = await services.status.status()
    const skill = report.skills.find((entry) => entry.name === id)
    if (skill === undefined) {
      throw new WebApiError(
        'SKILL_NOT_FOUND',
        `Skill "${id}" does not exist in this repository`,
        404,
      )
    }
    return c.json<SkillResponse>({ skill })
  })

  app.get('/api/agents', async (c) => {
    return c.json<AgentsResponse>({ agents: await services.registry.detectAll() })
  })

  app.get('/api/status', async (c) => {
    const report = await services.status.status()
    return c.json(report)
  })

  /* ---- mutating API (M10.7) ---- */

  app.post('/api/skills', async (c) => {
    const body = await requireJsonBody(c)
    const name = stringField(body, 'name')
    const description = stringField(body, 'description')
    const input: { name: string; description?: string } = { name }
    if (description !== undefined) {
      input.description = description
    }
    const created = await services.skills.createSkill(input)
    return c.json({ created }, 201)
  })

  app.put('/api/skills/:id/content', async (c) => {
    const id = c.req.param('id')
    const body = await requireJsonBody(c)
    const content = stringField(body, 'content')
    const saved = await services.skills.writeSkillMarkdown({ name: id, content })
    return c.json({ saved })
  })

  app.delete('/api/skills/:id', async (c) => {
    const id = c.req.param('id')
    const removed = await services.skills.removeSkill({ name: id })
    return c.json({ removed })
  })

  app.post('/api/skills/:id/enable', async (c) => {
    const id = c.req.param('id')
    const body = await requireJsonBody(c)
    const agent = stringField(body, 'agent')
    const assignment = await services.skills.enableSkill({ name: id, agent })
    return c.json({ assignment })
  })

  app.post('/api/skills/:id/disable', async (c) => {
    const id = c.req.param('id')
    const body = await requireJsonBody(c)
    const agent = stringField(body, 'agent')
    const assignment = await services.skills.disableSkill({ name: id, agent })
    return c.json({ assignment })
  })

  app.post('/api/reconcile', async (c) => {
    const reconcile = await services.skills.install()
    return c.json<ReconcileResponse>({ reconcile })
  })

  app.all('/api/*', (c) => c.json(unknownRouteEnvelope(), 404))

  /* ---- frontend static / SPA (M11.10) ---- */

  app.all('*', (c) => {
    if (staticDir === undefined) {
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        if (isHtmlNavigation(c)) {
          return c.json(
            {
              error: {
                code: 'WEB_ASSETS_MISSING',
                message:
                  'The frontend is not built. Run "pnpm build" in the repository or start the built CLI.',
                recoverable: true,
              },
            },
            503,
          )
        }
        return c.text('Not Found', 404)
      }
      return c.text('Method Not Allowed', 405)
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.text('Method Not Allowed', 405)
    }
    return staticHandler(staticDir)(c)
  })

  return app
}

/* ---- request helpers ---- */

interface JsonRequestLike {
  json(): Promise<unknown>
}

async function requireJsonBody(c: { req: JsonRequestLike }): Promise<Record<string, unknown>> {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    throw new WebApiError('INVALID_REQUEST', 'The request body must be valid JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WebApiError('INVALID_REQUEST', 'The request body must be a JSON object')
  }
  return payload as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebApiError(
      'INVALID_REQUEST',
      `Field "${field}" is required and must be a non-empty string`,
    )
  }
  return value
}

function toStatusCode(status: number): ContentfulStatusCode {
  if (status < 200 || status > 599) {
    return 500
  }
  return status as ContentfulStatusCode
}
