import { z } from 'zod'

/** File name of the Fleet inventory inside `<repositoryRoot>/.skillbox/`. */
export const FLEET_CONFIG_FILE_NAME = 'fleet.yaml'

const nonEmptyString = (): z.ZodString => z.string().trim().min(1, 'must not be empty')

export const fleetHostConfigSchema = z.object({
  name: nonEmptyString(),
  host: nonEmptyString(),
  user: nonEmptyString().optional(),
  port: z.number().int().positive().optional(),
  identityFile: nonEmptyString().optional(),
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
