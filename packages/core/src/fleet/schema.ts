import { z } from 'zod'

/** File name of the Fleet inventory inside `<repositoryRoot>/.skillbox/`. */
export const FLEET_CONFIG_FILE_NAME = 'fleet.yaml'

const nonEmptyString = (): z.ZodString => z.string().trim().min(1, 'must not be empty')

/**
 * A hostname / IPv4 / bracketed-IPv6 passed positionally to `ssh`. The value
 * must not start with `-` — ssh would read it as an option (e.g.
 * `-oProxyCommand=...` executes arbitrary local commands).
 */
const HOST_PATTERN = /^(?!\-)(?:[A-Za-z0-9_\-:.]+|\[[0-9A-Fa-f:.]+\])$/
const USER_PATTERN = /^(?!\-)[A-Za-z0-9._%$-]+$/
/** Local paths (identity file) must never begin with `-` for the same reason. */
const OPTION_SAFE_PATTERN = /^(?!\-).+$/s

const hostString = (): z.ZodString =>
  nonEmptyString().regex(HOST_PATTERN, 'must be a hostname or IP address, not starting with "-"')
const userString = (): z.ZodString =>
  nonEmptyString().regex(
    USER_PATTERN,
    'must be a username, not starting with "-" or containing whitespace, "/" or "@"',
  )
const optionSafeString = (): z.ZodString =>
  nonEmptyString().regex(OPTION_SAFE_PATTERN, 'must not start with "-"')

export const fleetHostConfigSchema = z.object({
  name: nonEmptyString(),
  host: hostString(),
  user: userString().optional(),
  port: z.number().int().positive().optional(),
  identityFile: optionSafeString().optional(),
  remotePath: nonEmptyString().optional(),
  skillboxBin: nonEmptyString().optional(),
  tags: z.array(nonEmptyString()).optional(),
})

export const fleetConfigSchema = z
  .object({
    version: z.literal(1),
    hosts: z.array(fleetHostConfigSchema),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>()
    for (const [index, host] of config.hosts.entries()) {
      if (seen.has(host.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate host name "${host.name}"`,
          path: ['hosts', index, 'name'],
        })
        continue
      }
      seen.add(host.name)
    }
  })

export type FleetConfigDocument = z.infer<typeof fleetConfigSchema>
