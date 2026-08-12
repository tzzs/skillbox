# Skillbox

English | [简体中文](./README.zh-CN.md)

> **A local-first, cross-agent package manager for AI agent skills.**
> Detect, import, track, distribute, and visualize skills used by Claude Code, Codex, and more.

---

## What is Skillbox?

As AI coding agents multiply, skills are becoming a developer asset—but the ecosystem is fragmented:

```text
Claude Code   →  ~/.claude/skills
Codex         →  ~/.codex/skills
Cursor        →  .cursor/skills
...           →  each agent has its own directory
```

Skillbox is an **Agent Skills Package Manager** that brings skills scattered across agent directories under one roof:

- Automatically **detects** local Claude Code and Codex installations and scans their existing skills.
- **Imports** external skills into the `skillbox.yaml` manifest with one command.
- Generates `skillbox.lock` and uses SHA-256 **integrity** hashes to track every skill’s contents.
- Maintains a **canonical library** in `~/.skillbox/library`, then distributes skills to agents using the configured link strategy (symlink, junction, or copy).
- Provides a **CLI**, **interactive menu**, and **local Web UI**, all sharing the same `@skillbox/core` logic.

> Current release: **v0.1 — Local Management**, focused on managing one local repository.
> See the [Roadmap](#roadmap) for Git sync, GitHub integration, marketplace, and fork/diff/merge capabilities.

## Quick Start

### Run with npx

From any skill-repository directory (Node.js 20 or later):

```bash
npx skillbox
```

The first run launches a short onboarding flow:

1. **Step 1 · Detect** — Detect Claude Code and Codex on this machine.
2. **Step 2 · Import** — Scan and import existing skills (optional).
3. **Step 3 · Sync** — Generate the manifest and lockfile, create the canonical library, and link skills to agents.

Then use the main menu: `My Skills / Agents / Import Existing Skills / Create Skill / Open Web UI / Settings / Exit`.

### Command reference

```text
skillbox                            Start the interactive menu
skillbox list                       List all skills in the current repository (--json for JSON)
skillbox agents                     Detect configured agents and their skill counts (--json for JSON)
skillbox create <name>              Create a skill (-d for description)
skillbox remove <name>              Remove a skill (-f also deletes its files)
skillbox enable <name> -a <agent>   Enable a skill for an agent
skillbox disable <name> -a <agent>  Disable a skill for an agent
skillbox install                    Reconcile skills and agent links
skillbox install --frozen-lockfile  Validate manifest and lockfile consistency; fail if they differ
skillbox install --ci               Same as --frozen-lockfile, for non-interactive CI
skillbox status                     Show repository, skill, agent, and Git status
skillbox sync                       Scan, detect, secret-scan, pull, resolve, commit, and push
skillbox pull                       Pull remote changes and reconcile local skills and lockfile
skillbox push                       Push local changes after connecting a remote
skillbox connect                    Authorize with GitHub Device Flow and connect a remote repository
skillbox disconnect                 Remove local GitHub authorization without changing the remote
skillbox web                        Start the local Web UI (default: http://127.0.0.1:43821)
skillbox -v, --version              Show the version
```

Run `skillbox --help` for all options, or `skillbox <command> --help` for command-specific help.

### Multi-device restore

Skillbox uses Git to synchronize between devices. The repository’s `skillbox.yaml` and `skillbox.lock` describe the desired skill state, and `npx skillbox install` restores that state on any machine.

```bash
# 1) Clone your skill repository
git clone https://github.com/<you>/<skills-repo>.git
cd <skills-repo>

# 2) Restore local installation: reconcile the manifest, rebuild the library, and link agents
npx skillbox install
```

`install` restores:

- **Local** (`local:` source): validates disk contents against lockfile integrity; restores missing or corrupted content from the repository.
- **Forked / Vendored**: checks out the source specified by the manifest.
- **Managed** (git/GitHub source, planned for 0.2+): downloads remotely and locks integrity.

To sync outward:

```bash
skillbox connect  # First time: GitHub Device Flow authorization and origin setup
skillbox sync     # Afterwards: scan → detect → secret scan → pull → resolve → commit → push
```

When two devices change the same skill, use the local Web UI first (`skillbox web` → **Sync**). It groups choices by skill and offers **Use this device**, **Use other device**, or **Keep both**. A restore point is created before sync; use the Restore action if you need to return to the pre-sync state. The interactive `skillbox conflicts` command is the advanced alternative.

To restore consistency when a repository has drifted:

```bash
skillbox pull
skillbox status
```

> `sync` commits only Skillbox-managed paths (`skillbox.yaml`, `skillbox.lock`, `skills/`, and `.skillbox/`). It does not touch other files you add manually. Before pushing, GitHub must be connected; otherwise the command explains how to run `skillbox connect`. Never resolve a sync disagreement with raw Git conflict markers: Skillbox keeps it as a recoverable review session instead.

### A minimal first-use example

```bash
cd ~/my-skills
skillbox create my-review-skill -d "Code review skill"
skillbox status
skillbox web
```

## Supported Agents

| Agent                          | Adapter                           | Status           |
| ------------------------------ | --------------------------------- | ---------------- |
| Claude Code                    | Built-in `@skillbox/core` adapter | Supported        |
| Codex                          | Built-in `@skillbox/core` adapter | Supported        |
| Cursor                         | —                                 | Planned (0.1.1+) |
| Gemini CLI / OpenCode / others | —                                 | Planned          |

Agent adapters detect, scan, link, and unlink skills, and report their capability model (global-skill support, symlinks, nested directories, and so on).

## Features

| Milestone | Capability                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| M0        | Monorepo scaffold: pnpm workspace, TypeScript, and Linux/macOS/Windows CI matrix                              |
| M1        | Core domain: managed/forked/local/vendored skills; ready/modified/outdated/conflict/missing/broken states     |
| M2        | Filesystem: atomic writes, path safety, directory scanning, skill validation, symlink safety, link strategies |
| M3        | Manifest: `skillbox.yaml` schema and deterministic serialization                                              |
| M4        | Lockfile: `skillbox.lock`, cross-platform SHA-256 integrity, and local-change detection                       |
| M5        | Agent adapter framework with Claude and Codex adapters                                                        |
| M6        | Canonical library, symlink-first distribution with copy fallback, and import conflict handling                |
| M7        | Idempotent reconcile engine, assignments, stale cleanup, and missing/broken detection                         |
| M8        | CLI: `list`, `agents`, `create`, `remove`, `enable`, `disable`, `install`, `status`, and `web`                |
| M9        | Interactive menu and first-run Detect/Import/Sync flow                                                        |
| M10       | Hono Web server with health, skills, agents, status, and reconcile APIs                                       |
| M11       | React/Vite Web UI for library, skill detail, agents, creation, and settings                                   |

> Each skill’s `SkillStatus` is calculated from the lockfile and disk contents. Editing a skill in your editor makes `status` show `modified`, and `skillbox list` reports it accurately.

## Installation

For system requirements, building from source, and local package-install verification, see [INSTALLATION.md](./INSTALLATION.md). In short: Node.js 20 or later and pnpm are required.

## Roadmap

- **0.2 — Git Sync**: Git client, GitHub App device flow, private repositories, `skillbox sync/pull/push`, secret scanning, and multi-device support.
  - Already present at the CLI layer: `sync/pull/push/connect/disconnect/status`, secret-scan integration, `install --frozen-lockfile/--ci`, and multi-device restore documentation.
  - Default GitHub wiring is complete (2026-08-12): the production factory and CLI adapter, actual `ahead/behind/remote` reporting, full `connect` orchestration (authorize → create/select repository → initialize → bind origin → persist → pull → push), and private-repository credential injection without persisting credentials. See [GAP_ANALYSIS.md §1.5](./GAP_ANALYSIS.md).
- **0.3 — Marketplace / Registry**: `skillbox search`, `add <source>`, managed cache, and updates.
- **0.4 — Skill Lifecycle**: `fork`, `vendor`, managed-edit Restore, `diff`, three-way merge, retained-operation `rollback`, and matching Web lifecycle actions are available; see [GAP_ANALYSIS.md](./GAP_ANALYSIS.md).
- **Security (P1)**: pre-install security scanning and risk display in the Web UI.

See [GAP_ANALYSIS.md](./GAP_ANALYSIS.md) for the detailed code-versus-documentation gap analysis.

## Architecture Summary

```text
          ┌───────────────────────────────┐
          │   skillbox CLI (Commander)    │
          │   skillbox interactive menu   │
          │   skillbox web (Hono + React) │
          └───────────────────────────────┘
                         │ shared business logic
          ┌──────────────▼──────────────┐
          │      @skillbox/core          │
          └──────────────▲──────────────┘
                         │
          ┌──────────────┴──────────────┐
          │ Filesystem / Agent / Runtime │
          │ Manifest / Lockfile /        │
          │ Reconcile / Library          │
          └─────────────────────────────┘
```

- **Monorepo**: `apps/web` (frontend), `packages/core` (domain and services), `packages/cli`, `packages/shared`, and `packages/testing`.
- **Single source of truth**: the CLI, interactive UI, and Web UI must all call `@skillbox/core`; none may duplicate business logic.

For the full design, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Documentation

| Document                                           | Description                                            |
| -------------------------------------------------- | ------------------------------------------------------ |
| [PRD.md](./PRD.md)                                 | Product requirements document                          |
| [SKILLBOX_SPEC.md](./SKILLBOX_SPEC.md)             | Technical specification                                |
| [ARCHITECTURE.md](./ARCHITECTURE.md)               | Architecture design                                    |
| [MVP_TASKS.md](./MVP_TASKS.md)                     | MVP tasks, including v0.1.0 E2E and release checklists |
| [GAP_ANALYSIS.md](./GAP_ANALYSIS.md)               | Code-versus-documentation gap list                     |
| [INSTALLATION.md](./INSTALLATION.md)               | Installation and build guide                           |
| [CONTRIBUTING.md](./CONTRIBUTING.md)               | Contribution guide                                     |
| [docs/e2e-acceptance.md](./docs/e2e-acceptance.md) | v0.1.0 E2E acceptance walkthrough                      |

## CI

The Linux/macOS/Windows CI matrix runs lint, typecheck, test, and build:

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)

> Placeholder: replace `OWNER/REPO` after the repository is public and GitHub Actions is configured.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow, commit conventions, and test expectations.

## License

[MIT](./LICENSE). The PRD/idea did not specify a license, so MIT is used by default. To adopt another license such as Apache-2.0, replace `LICENSE` and update every package accordingly.
