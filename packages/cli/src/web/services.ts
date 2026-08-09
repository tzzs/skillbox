import {
  createDefaultAgentRegistry,
  RuntimeConfigService,
  SkillService,
  StatusService,
  type AgentRegistry,
} from '@skillbox/core'
import { SkillboxHome } from '@skillbox/core'
import type { WebServices } from './types.js'

export interface CreateWebServicesOptions {
  /** Repository root managed by the API. */
  repositoryRoot: string
  /** Skillbox home root (library + links state). */
  homeRoot: string
  /** Agent registry; defaults to the built-in Claude + Codex adapters. */
  registry?: AgentRegistry
}

/**
 * Builds the Core service bundle behind the web API (M10.6: every route goes
 * through Core services — never through direct file access).
 */
export function createWebServices(options: CreateWebServicesOptions): WebServices {
  const registry = options.registry ?? createDefaultAgentRegistry()
  const { repositoryRoot, homeRoot } = options
  const config = new RuntimeConfigService({
    configFilePath: new SkillboxHome({ root: homeRoot }).configFilePath(),
  })
  return {
    registry,
    repositoryRoot,
    homeRoot,
    config,
    skills: new SkillService({
      repositoryRoot,
      homeRoot,
      registry,
    }),
    status: new StatusService({
      repositoryRoot,
      registry,
    }),
  }
}
