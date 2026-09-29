import { describe, expect, it } from 'vitest'

/**
 * The invariant that lets `@skillbox/shared` be `private: true`.
 *
 * `@skillbox/cli` is installed by people who never heard of this package. If
 * any module here exported a value, `packages/cli/dist` would carry a runtime
 * `import … from '@skillbox/shared'` and their process would die with
 * `Cannot find package '@skillbox/shared'` — a crash, not a type warning, and
 * one that only appears after a publish.
 *
 * This is a runtime assertion rather than a source grep on purpose: it checks
 * what a consumer would actually load, so `export type`, `export interface` and
 * `export { someType }` all pass while a plain `export function`/`export const`
 * or a value re-export from another package fails.
 */
describe('@skillbox/shared is types only', () => {
  it('exports no runtime value', async () => {
    expect(Object.keys(await import('./index.js'))).toEqual([])
  })
})
