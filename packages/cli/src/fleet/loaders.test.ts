import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { FleetService } from '@skillbox/core'
import { createDefaultFleetService, defaultFleetConfigPath } from './loaders.js'

describe('defaultFleetConfigPath', () => {
  it('points at .skillbox/fleet.yaml under the repository root', () => {
    expect(defaultFleetConfigPath('/repo')).toBe(path.join('/repo', '.skillbox', 'fleet.yaml'))
  })
})

describe('createDefaultFleetService', () => {
  it('builds a real FleetService rooted at the repository', () => {
    expect(createDefaultFleetService('/repo')).toBeInstanceOf(FleetService)
  })
})
