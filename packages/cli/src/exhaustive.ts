/**
 * Exhaustiveness guard for `switch` statements over a union: a `default` branch
 * that calls this stops compiling the moment the union grows a member the switch
 * does not handle, which is the difference between "the new case renders nothing"
 * and a build failure that says where to fix it.
 *
 * It lives here rather than in `@skillbox/shared` because that package is
 * workspace-private and this is *runtime code*: `packages/cli` is what npm users
 * install, and a value import of a package they cannot resolve would throw at
 * startup instead of helping them.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`)
}
