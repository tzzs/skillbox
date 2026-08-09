export const version = '0.1.0'

export * from './domain/index.js'
export * from './errors.js'
export * from './fs/index.js'
export * from './agent/index.js'
export * from './manifest/index.js'
export * from './lockfile/index.js'
export * from './integrity/index.js'
export * from './runtime/index.js'
export * from './reconcile/index.js'
export * from './services/index.js'
export * from './git/index.js'
export * from './logging/index.js'
export * from './github/index.js'
export * from './ignore/index.js'
export * from './install/index.js'
// Both the manifest helper and the install transaction export `updateSkill`;
// the transaction shape `updateSkill(source, options)` (M16.2) is the one the
// CLI adapter picks up via its arity check — re-export it explicitly so the
// name resolves to the transaction instead of the ambiguous star export.
export { updateSkill } from './install/index.js'
export * from './lifecycle/index.js'
export * from './secret-scan/index.js'
export * from './security/index.js'
export * from './registry/index.js'
export * from './diff/index.js'
export * from './merge/index.js'
