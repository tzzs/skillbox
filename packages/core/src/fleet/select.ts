import { ErrorCode, SkillboxError } from '../errors.js'
import type { FleetHostConfig, FleetHostSelector } from './types.js'

/**
 * Resolves a selector against a loaded config's host list: `hostNames` and
 * `tags` narrow the configured inventory (union of both, each name/tag
 * matched at least once), `adHoc` entries are appended verbatim. No selector
 * fields at all returns every configured host. Duplicate names between a
 * matched config host and an ad-hoc entry keep both — Fleet dedupes on
 * `name`, but two unrelated entries sharing a label is a config mistake, not
 * this function's to silently resolve.
 *
 * Throws `FLEET_HOST_NOT_FOUND` for a name in `hostNames` that doesn't exist
 * in `config.hosts`.
 */
export function selectHosts(
  config: { hosts: readonly FleetHostConfig[] },
  selector: FleetHostSelector = {},
): FleetHostConfig[] {
  const { hostNames, tags, adHoc = [] } = selector
  // An entirely empty selector defaults to the whole configured inventory;
  // once *any* selection field is set (including a pure `--ssh` ad-hoc
  // entry), the config contributes only what `hostNames`/`tags` actually
  // matched — never the rest of the file.
  const isEmptySelector = hostNames === undefined && tags === undefined && adHoc.length === 0

  let matched: FleetHostConfig[]
  if (isEmptySelector) {
    matched = [...config.hosts]
  } else {
    const byName = new Map(config.hosts.map((host) => [host.name, host]))
    const picked = new Map<string, FleetHostConfig>()
    for (const name of hostNames ?? []) {
      const host = byName.get(name)
      if (host === undefined) {
        throw new SkillboxError(ErrorCode.FLEET_HOST_NOT_FOUND, `No fleet host named "${name}"`, {
          context: { name },
        })
      }
      picked.set(host.name, host)
    }
    if (tags !== undefined && tags.length > 0) {
      const tagSet = new Set(tags)
      for (const host of config.hosts) {
        if ((host.tags ?? []).some((tag) => tagSet.has(tag))) {
          picked.set(host.name, host)
        }
      }
    }
    matched = [...picked.values()]
  }

  return [...matched, ...adHoc]
}

const AD_HOC_HOST_PATTERN = /^(?:([^@\s]+)@)?([^@\s:]+)(?::(\d+))?$/

/**
 * Parses a `--ssh [user@]host[:port]` command-line entry into a host config
 * usable without a `fleet.yaml` entry. The raw spec becomes the host's
 * `name` (and its result label), so distinct specs never collide.
 */
export function parseAdHocHost(spec: string): FleetHostConfig {
  const trimmed = spec.trim()
  const match = AD_HOC_HOST_PATTERN.exec(trimmed)
  if (match === null) {
    throw new SkillboxError(
      ErrorCode.FLEET_CONFIG_INVALID,
      `Invalid --ssh host "${spec}" (expected [user@]host[:port])`,
      { context: { spec } },
    )
  }
  const [, user, host, port] = match
  const config: FleetHostConfig = { name: trimmed, host: host as string }
  if (user !== undefined) config.user = user
  if (port !== undefined) config.port = Number.parseInt(port, 10)
  return config
}
