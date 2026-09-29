/**
 * `@skillbox/shared` — the shapes two Skillbox packages must agree on and
 * therefore may not each define for themselves.
 *
 * The whole package is one file: `./web-api.js`, the Web JSON API contract,
 * implemented by `packages/cli/src/web` and called by `apps/web/src/api.ts`.
 *
 * Two properties hold this together, and `src/index.test.ts` is what enforces
 * the first:
 *
 *  - **Types only.** Nothing here exists at runtime. `@skillbox/shared` is
 *    `private: true` and `@skillbox/cli` publishes code that npm users install,
 *    so a single runtime export here would become `Cannot find module
 *    '@skillbox/shared'` on their machine — the same reason `@skillbox/cli`
 *    ships no `.d.ts` either (see `scripts/verify-package.mjs`).
 *  - **`@skillbox/core` is a devDependency.** These types are *typed against*
 *    Core's domain shapes; they never import Core's code, so nothing has to be
 *    installed to use them.
 */

export * from './web-api.js'
