import { describe, expect, it } from 'vitest'
import { MigrationRegistry } from './registry.js'

describe('MigrationRegistry', () => {
  it('runs pending migrations in registration order and records each successful migration', async () => {
    const events: string[] = []
    const completed: string[] = ['already-applied']
    const registry = new MigrationRegistry([
      {
        id: 'already-applied',
        run: async () => {
          events.push('unexpected')
        },
      },
      {
        id: 'first',
        run: async () => {
          events.push('first')
        },
      },
      {
        id: 'second',
        run: async () => {
          events.push('second')
        },
      },
    ])

    const result = await registry.run({
      repositoryRoot: '/repo',
      store: {
        listCompleted: async () => completed,
        markCompleted: async (id) => {
          completed.push(id)
        },
      },
    })

    expect(events).toEqual(['first', 'second'])
    expect(completed).toEqual(['already-applied', 'first', 'second'])
    expect(result.applied).toEqual(['first', 'second'])
    expect(result.skipped).toEqual(['already-applied'])
  })

  it('does not record a migration when its execution fails', async () => {
    const completed: string[] = []
    const registry = new MigrationRegistry([
      {
        id: 'broken',
        run: async () => {
          throw new Error('cannot migrate')
        },
      },
    ])

    await expect(
      registry.run({
        repositoryRoot: '/repo',
        store: {
          listCompleted: async () => completed,
          markCompleted: async (id) => {
            completed.push(id)
          },
        },
      }),
    ).rejects.toThrow('cannot migrate')
    expect(completed).toEqual([])
  })

  it('rejects duplicate migration identifiers', () => {
    expect(
      () =>
        new MigrationRegistry([
          { id: 'duplicate', run: async () => undefined },
          { id: 'duplicate', run: async () => undefined },
        ]),
    ).toThrow('duplicate')
  })

  it('publishes started and completed progress events for an applied migration', async () => {
    const events: string[] = []
    const registry = new MigrationRegistry([{ id: 'v2', run: async () => undefined }])

    await registry.run({
      repositoryRoot: '/repo',
      store: {
        listCompleted: async () => [],
        markCompleted: async () => undefined,
      },
      events: {
        emit: (event) => {
          events.push(`${event.phase}:${event.migrationId}`)
          return { delivered: 1, failures: [] }
        },
      },
      now: () => new Date('2026-08-13T00:00:00.000Z'),
    })

    expect(events).toEqual(['started:v2', 'completed:v2'])
  })
})
