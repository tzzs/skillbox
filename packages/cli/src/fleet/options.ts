import { parseAdHocHost, type FleetHostSelector, type FleetRunOptions } from '@skillbox/core'

/** Commander repeatable-option accumulator: `--host a --host b` → `['a', 'b']`. */
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

export interface FleetCliOptions {
  host?: string[]
  tag?: string[]
  ssh?: string[]
  concurrency?: string
  dryRun?: boolean
}

/** Builds the Fleet selector from the shared `--host` / `--tag` / `--ssh` flags. */
export function selectorFromOptions(options: FleetCliOptions): FleetHostSelector {
  const selector: FleetHostSelector = {}
  if (options.host !== undefined && options.host.length > 0) {
    selector.hostNames = options.host
  }
  if (options.tag !== undefined && options.tag.length > 0) {
    selector.tags = options.tag
  }
  if (options.ssh !== undefined && options.ssh.length > 0) {
    selector.adHoc = options.ssh.map(parseAdHocHost)
  }
  return selector
}

/** Builds Fleet run options from the shared `--concurrency` / `--dry-run` flags. */
export function runOptionsFromOptions(options: FleetCliOptions): FleetRunOptions {
  const runOptions: FleetRunOptions = {}
  if (options.concurrency !== undefined) {
    const parsed = Number.parseInt(options.concurrency, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      runOptions.concurrency = parsed
    }
  }
  if (options.dryRun === true) {
    runOptions.dryRun = true
  }
  return runOptions
}
