/**
 * Contract suite shared by every first-party CLI agent adapter.
 *
 * This deliberately tests the public `AgentAdapter` seam: detection, skill
 * directory resolution, scanning, linking and ownership-aware unlinking. New
 * adapters supply only their agent-specific configuration.
 */
export {
  runCliAdapterSuite as runAgentConformanceSuite,
  type CliAdapterSpec as AgentConformanceSpec,
} from './cli-adapter-suite.js'
