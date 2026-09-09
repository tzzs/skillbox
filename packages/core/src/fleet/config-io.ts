import { parse as parseYaml } from 'yaml'
import { ErrorCode, SkillboxError } from '../errors.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { FLEET_CONFIG_FILE_NAME, fleetConfigSchema } from './schema.js'
import type { FleetConfig } from './types.js'

/**
 * Reads and validates `<repositoryRoot>/.skillbox/fleet.yaml`.
 *
 * Throws:
 * - `FLEET_CONFIG_NOT_FOUND` when the file is missing
 * - `FLEET_CONFIG_INVALID` for invalid YAML, a non-mapping document, or a
 *   schema-invalid document (including duplicate host names)
 */
export async function loadFleetConfig(
  configPath: string,
  filesystem: FilesystemService = new FilesystemService(),
): Promise<FleetConfig> {
  if (!(await filesystem.exists(configPath))) {
    throw new SkillboxError(
      ErrorCode.FLEET_CONFIG_NOT_FOUND,
      `No ${FLEET_CONFIG_FILE_NAME} found at "${configPath}"`,
      { context: { path: configPath } },
    )
  }

  let document: unknown
  try {
    document = parseYaml(await filesystem.readFile(configPath))
  } catch (error) {
    throw new SkillboxError(
      ErrorCode.FLEET_CONFIG_INVALID,
      `${FLEET_CONFIG_FILE_NAME} is not a valid YAML document`,
      { cause: error, context: { path: configPath } },
    )
  }

  const result = fleetConfigSchema.safeParse(document)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    throw new SkillboxError(
      ErrorCode.FLEET_CONFIG_INVALID,
      `${FLEET_CONFIG_FILE_NAME} failed schema validation`,
      { context: { path: configPath, issues } },
    )
  }
  return result.data
}
