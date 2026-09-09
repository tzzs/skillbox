import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface HttpFixtureRequest {
  method: string
  path: string
  body: string
  headers: IncomingMessage['headers']
}

export interface HttpFixtureResponse {
  status?: number
  headers?: Record<string, string>
  body?: string
}

export type HttpFixtureHandler = (
  request: HttpFixtureRequest,
) => HttpFixtureResponse | Promise<HttpFixtureResponse>

export interface HttpFixture {
  url: string
  requests: HttpFixtureRequest[]
  close(): Promise<void>
}

/** Starts a loopback-only, in-process HTTP fixture for deterministic tests. */
export async function createHttpFixture(handler: HttpFixtureHandler): Promise<HttpFixture> {
  const requests: HttpFixtureRequest[] = []
  const server = createServer(async (request, response) => {
    try {
      const fixtureRequest = await readRequest(request)
      requests.push(fixtureRequest)
      const fixtureResponse = await handler(fixtureRequest)
      writeResponse(response, fixtureResponse)
    } catch {
      writeResponse(response, { status: 500, body: 'fixture handler failed' })
    }
  })
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('HTTP fixture did not expose a TCP address')
  }
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => closeServer(server) }
}

async function readRequest(request: IncomingMessage): Promise<HttpFixtureRequest> {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) {
    body += chunk
  }
  return {
    method: request.method ?? 'GET',
    path: request.url ?? '/',
    body,
    headers: request.headers,
  }
}

function writeResponse(response: ServerResponse, fixture: HttpFixtureResponse): void {
  response.writeHead(fixture.status ?? 200, fixture.headers)
  response.end(fixture.body ?? '')
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
