import type {
  AgentCapabilities,
  AgentDetectionConfidence,
  AgentDetectionResult,
  AgentInstalledSkill,
} from '../domain/agent.js'
import type { AgentAdapter } from './adapter.js'
import { ClaudeAdapter } from './adapters/claude.js'
import { CodexAdapter } from './adapters/codex.js'
import { CursorAdapter } from './adapters/cursor.js'
import { GeminiAdapter } from './adapters/gemini.js'

/** Detection status of one agent, enriched with its installed skills. */
export interface AgentDetectionSummary {
  id: string
  name: string
  capabilities: AgentCapabilities
  detected: boolean
  confidence: AgentDetectionConfidence
  /** Raw list of skill directories for the agent, whether or not it exists. */
  skillDirectories: string[]
  version?: string
  executable?: string
  /** Total number of skills currently installed for the agent. */
  skillCount: number
  /** Skills that point back into Skillbox's managed library. */
  managedSkillCount: number
  /** Hand-written/unmanaged skills that Skillbox will preserve. */
  externalSkillCount: number
}

/**
 * Registry of the adapters Core knows about. `Core` never branches on an
 * agent id; everything routes through `list()` / `detectAll()`.
 */
export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>()

  constructor(initial: AgentAdapter[] = []) {
    for (const adapter of initial) {
      this.register(adapter)
    }
  }

  /** Registers (or replaces) an adapter by `id`. */
  register(adapter: AgentAdapter): this {
    this.adapters.set(adapter.id, adapter)
    return this
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  /**
   * Detects every registered agent and reports its status together with the
   * number of installed skills. A single failing adapter never aborts the
   * whole run.
   */
  async detectAll(): Promise<AgentDetectionSummary[]> {
    const results: AgentDetectionSummary[] = []
    for (const adapter of this.list()) {
      results.push(await this.detectOne(adapter))
    }
    return results
  }

  private async detectOne(adapter: AgentAdapter): Promise<AgentDetectionSummary> {
    let detection: AgentDetectionResult
    try {
      detection = await adapter.detect()
    } catch {
      detection = {
        detected: false,
        skillDirectories: [],
        confidence: 'low',
      }
    }

    let skills: AgentInstalledSkill[] = []
    try {
      skills = await adapter.scanSkills()
    } catch {
      skills = []
    }
    const managedSkillCount = skills.filter((skill) => skill.managedBySkillbox).length

    const summary: AgentDetectionSummary = {
      id: adapter.id,
      name: adapter.name,
      capabilities: adapter.capabilities,
      detected: detection.detected,
      confidence: detection.confidence,
      skillDirectories: detection.skillDirectories,
      skillCount: skills.length,
      managedSkillCount,
      externalSkillCount: skills.length - managedSkillCount,
    }
    if (detection.version !== undefined) {
      summary.version = detection.version
    }
    if (detection.executable !== undefined) {
      summary.executable = detection.executable
    }
    return summary
  }
}

/** Registry with the first-party adapters pre-registered. */
export function createDefaultAgentRegistry(): AgentRegistry {
  return new AgentRegistry()
    .register(new ClaudeAdapter())
    .register(new CodexAdapter())
    .register(new CursorAdapter())
    .register(new GeminiAdapter())
}
