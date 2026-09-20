# Release readiness

Skillbox is currently prepared as a **private monorepo release candidate**.
The workspace root stays private by design. The four distributable packages
are `@skillbox/shared`, `@skillbox/core`, `@skillbox/web-server`, and
`@skillbox/cli`; they retain
`"private": true` until the release owner confirms the npm scope and package
ownership. Removing that guard without owning `@skillbox` would turn a
configuration edit into an attempted public release.

## Automated release gates

Run these commands from a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node scripts/verify-package.mjs
pnpm release:smoke
```

`release:smoke` packs shared, core, web-server, and CLI, creates a new npm consumer
directory with its own cache, installs only those tarballs, and verifies the
installed `skillbox --help` command. It therefore checks package file lists,
the bin entry, and replacement of `workspace:*` dependencies with release
versions. CI runs the same smoke test after each OS-specific build.

## Owner-controlled publication gates

These decisions require credentials or external confirmation and are not
automated by the repository:

1. Confirm ownership of the `@skillbox` npm scope and the public package names.
2. Choose the release version and replace the matching package versions.
3. Remove `"private": true` only from packages being published, then publish
   in dependency order: shared, core, web-server, CLI.
4. Run `npm publish --dry-run` with the release account before publishing.
5. Record the supported Node version and complete the existing manual
   cross-platform acceptance in `docs/e2e-acceptance.md`.

The publication decision is intentionally separate from the tarball smoke
test: the latter proves a consumer can install the candidate without exposing
an unowned package name.
