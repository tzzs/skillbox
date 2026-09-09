import * as path from 'node:path'
import { FleetService } from '@skillbox/core'

/** Default `fleet.yaml` location: `<repositoryRoot>/.skillbox/fleet.yaml`. */
export function defaultFleetConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, '.skillbox', 'fleet.yaml')
}

/** Production wiring: a real `FleetService` reading the repository's `fleet.yaml` over real SSH. */
export function createDefaultFleetService(repositoryRoot: string): FleetService {
  return new FleetService({ configPath: defaultFleetConfigPath(repositoryRoot) })
}
