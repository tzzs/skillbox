# Release readiness

Skillbox is currently prepared as a **private monorepo release candidate**.
The workspace root stays private by design. Two packages are distributable:
`@skillbox/core` and `@skillbox/cli`. `@skillbox/shared` is **not** on that list —
it holds the Web API contract as types only and is `private: true` on purpose,
because nothing that ships may reference a package the registry does not have
(`scripts/verify-package.mjs` asserts exactly that). `apps/web` and
`packages/testing` are private for other reasons (a SPA and a test harness).

Both publishable packages are already `"private": false` (the release-metadata
pass removed that blocker), so `pnpm publish -r` on a `v*` tag would publish
them today. What still gates a release is external, not a config file: nobody
has confirmed ownership of the `@skillbox` npm scope, and the version has never
been chosen. `packages/shared`, `packages/testing`, `apps/web` and the workspace
root are private, and `packages/shared` is meant to stay that way.

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

`release:smoke` packs core and CLI, creates a new npm consumer directory with
its own cache, installs only those tarballs, and verifies the
installed `skillbox --help` command. It therefore checks package file lists,
the bin entry, and replacement of workspace dependencies with release
versions. Because `@skillbox/shared` is not in the consumer's dependency graph,
this is also the test that proves the CLI runs without the private contract
package. CI runs the same smoke test after each OS-specific build.

## Owner-controlled publication gates

These decisions require credentials or external confirmation and are not
automated by the repository:

1. Confirm ownership of the `@skillbox` npm scope and the public package names.
2. Choose the release version and replace the matching package versions.
3. Publish in dependency order: core, then CLI (`pnpm publish -r` already walks
   workspace deps first and skips the four `private: true` packages). There is
   no `@skillbox/web-server` package — the Hono server still ships inside
   `@skillbox/cli` (GAP §5) — and `@skillbox/shared` is not published at all:
   its types are a build-time dependency of the server and the SPA, and
   `@skillbox/cli` deliberately ships no `.d.ts` so nothing published points at
   it. If a typed programmatic CLI is ever wanted, that is the decision to
   revisit here, not a config edit to make quietly.
4. Run `npm publish --dry-run` with the release account before publishing.
5. Record the supported Node version and complete the existing manual
   cross-platform acceptance in `docs/e2e-acceptance.md`.

The publication decision is intentionally separate from the tarball smoke
test: the latter proves a consumer can install the candidate without exposing
an unowned package name.
