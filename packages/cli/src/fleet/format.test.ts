import { describe, expect, it } from 'vitest'
import type { FleetHostConfig, FleetRunResult } from '@skillbox/core'
import { renderFleetHostsTable, renderFleetRunTable } from './format.js'

describe('renderFleetHostsTable', () => {
  it('reports an empty inventory', () => {
    expect(renderFleetHostsTable([])).toContain('no fleet hosts configured')
  })

  it('renders configured hosts as a table', () => {
    const hosts: FleetHostConfig[] = [
      { name: 'web-1', host: '10.0.0.11', user: 'deploy', port: 2222, tags: ['prod', 'web'] },
      { name: 'web-2', host: '10.0.0.12' },
    ]
    const table = renderFleetHostsTable(hosts)
    expect(table).toContain('web-1')
    expect(table).toContain('10.0.0.11')
    expect(table).toContain('deploy')
    expect(table).toContain('prod,web')
    expect(table).toContain('web-2')
    expect(table).toContain('-')
  })
})

describe('renderFleetRunTable', () => {
  it('summarizes a fully successful run', () => {
    const result: FleetRunResult = {
      operation: 'install',
      results: [
        {
          host: 'web-1',
          ok: true,
          exitCode: 0,
          stdout: 'installed\n',
          stderr: '',
          durationMs: 120,
        },
        { host: 'web-2', ok: true, exitCode: 0, stdout: 'installed\n', stderr: '', durationMs: 95 },
      ],
    }
    const rendered = renderFleetRunTable(result)
    expect(rendered).toContain('web-1')
    expect(rendered).toContain('ok')
    expect(rendered).toContain('All 2 host(s) succeeded.')
  })

  it('surfaces per-host failures and a failure count', () => {
    const result: FleetRunResult = {
      operation: 'update',
      results: [
        { host: 'web-1', ok: true, exitCode: 0, stdout: 'updated\n', stderr: '', durationMs: 80 },
        {
          host: 'web-2',
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: 'permission denied\n',
          durationMs: 40,
        },
        {
          host: 'web-3',
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: '',
          durationMs: 5,
          error: 'connection refused',
        },
      ],
    }
    const rendered = renderFleetRunTable(result)
    expect(rendered).toContain('FAIL')
    expect(rendered).toContain('permission denied')
    expect(rendered).toContain('connection refused')
    expect(rendered).toContain('2 of 3 host(s) failed.')
  })
})
