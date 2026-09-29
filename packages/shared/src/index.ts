/**
 * `@skillbox/shared` — the pieces two or more Skillbox packages must agree on
 * and therefore may not each define for themselves.
 *
 * `./web-api.js` is the bulk of it: the Web JSON API contract, implemented by
 * `packages/cli/src/web` and called by `apps/web/src/api.ts`.
 */

export * from './web-api.js'

/**
 * Exhaustiveness guard for `switch` statements over a union: a `default` branch
 * that calls this stops compiling the moment the union grows a member the switch
 * does not handle, which is the difference between "the new case renders nothing"
 * and a build failure that says where to fix it.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`)
}
