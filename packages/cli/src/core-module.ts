/**
 * Shared seams for the CLI's core-module adapters.
 *
 * The sync, marketplace and skill-lifecycle subcommands each define their own
 * provider contracts (a sibling `types.js`) and adapt the shipped
 * `@skillbox/core` exports onto them at runtime through a dynamic import. That
 * way a build missing an expected export fails with a typed
 * {@link SkillboxError} and a recovery hint instead of crashing on `undefined`.
 *
 * This module centralises the parts every adapter repeats: loading the core
 * module map (injectable so focused wiring tests can hand in a fake), the
 * "export missing" error, and the structural record/string readers used to
 * tolerate small shape differences between core result objects and the CLI
 * contracts.
 */
import { SkillboxError, type SkillboxErrorCode } from '@skillbox/core'

/** Loads the core package as an opaque module map (injectable in tests). */
export type CoreModuleLoader = () => Promise<Record<string, unknown>>

export async function loadSkillboxCore(): Promise<Record<string, unknown>> {
  try {
    return (await import('@skillbox/core')) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Builds the "this build is missing an export" error the adapters throw. */
export function coreExportUnavailable(code: SkillboxErrorCode, hint: string): SkillboxError {
  return new SkillboxError(code, hint)
}

/** Narrows an unknown to a plain record, or `undefined` for non-objects. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/** Reads a non-empty string field from a (possibly absent) record. */
export function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
