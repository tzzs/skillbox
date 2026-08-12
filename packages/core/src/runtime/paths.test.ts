import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_DIRECTORY_NAMES, buildSkillboxHomeLayout } from './paths.js'

describe('Skillbox home paths', () => {
  it('includes durable operation state and lock directories in the home layout', () => {
    const root = path.resolve('skillbox-home')
    const layout = buildSkillboxHomeLayout(root)

    expect(HOME_DIRECTORY_NAMES).toEqual([
      'library',
      'cache',
      'state',
      'tmp',
      'logs',
      'operations',
      'backups',
      'runtimeLocks',
    ])
    expect(layout.operations).toBe(path.join(root, 'operations'))
    expect(layout.backups).toBe(path.join(root, 'backups'))
    expect(layout.runtimeLocks).toBe(path.join(root, 'runtimeLocks'))
    expect(layout.syncState).toBe(path.join(root, 'state', 'sync'))
    expect(layout.syncSnapshots).toBe(path.join(root, 'state', 'sync', 'snapshots'))
    expect(layout.syncSessions).toBe(path.join(root, 'state', 'sync', 'sessions'))
    expect(layout.syncTrees).toBe(path.join(root, 'state', 'sync', 'trees'))
  })
})
