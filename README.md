# Skillbox

> **Local-first、跨 Agent 的 Agent Skills Package Manager。**
> 统一管理 Claude Code、Codex 等 AI Agent 使用的 Skills —— 检测、导入、追踪、分发、可视化。

---

## What is Skillbox

AI Coding Agent 数量增加，Skills 正在成为新的开发者资产，但目前生态碎片化严重：

```
Claude Code   →  ~/.claude/skills
Codex         →  ~/.codex/skills
Cursor        →  .cursor/skills
...           →  每个 Agent 一套自己的目录
```

Skillbox 像一个 **Agent Skills Package Manager**，把散落在各 Agent 目录的 Skills 统一收编：

- 自动**检测**本机已安装的 Claude Code / Codex，扫描它们目录里的既有 Skills
- 一键 **Import** 导入外部 Skills，纳入 `skillbox.yaml`（manifest）管理
- 生成 `skillbox.lock`（lockfile），用 SHA-256 **integrity** 追踪每个 Skill 的内容
- 在 `~/.skillbox/library` 建立 **canonical library**，再按配置的 link strategy（symlink / junction / copy）分发链接给各 Agent
- 通过 **CLI**、**交互菜单**、**本地 Web UI** 三种入口管理，全部共享 `@skillbox/core` 同一套核心逻辑

> 当前版本 **V0.1 — Local Management**：专注本机单仓库管理。
> Git Sync / GitHub 集成 / Marketplace / Fork-Diff-Merge 等能力见下方 [Roadmap](#roadmap)。

---

## Quick Start

### npx 一键使用

在任意 Skill 仓库目录下执行（Node.js ≥ 20）：

```bash
npx skillbox
```

首次运行会自动执行入门引导（仅需即可完成首次使用，无需额外阅读文档）：

1. **Step 1 · Detect** —— 检测本机 Claude Code / Codex
2. **Step 2 · Import** —— 扫描并导入既有 Skills（可跳过）
3. **Step 3 · Sync** —— 生成 manifest 与 lockfile，建立 canonical library，链接到 Agents

之后进入主菜单：`My Skills / Agents / Import Existing Skills / Create Skill / Open Web UI / Settings / Exit`。

### 命令速查表

直接使用 CLI 子命令（所有命令行为与交互菜单一致）：

```text
skillbox                启动交互菜单（无参数时）
skillbox list           列出当前仓库所有 Skill          （--json 输出 JSON）
skillbox agents          检测已配置的 Agent 及 Skill 数  （--json 输出 JSON）
skillbox create <name>   创建新 Skill（-d 描述）
skillbox remove <name>   移除 Skill（-f 同时删除文件）
skillbox enable <name>   -a <agent>   为指定 Agent 启用 Skill
skillbox disable <name>  -a <agent>   为指定 Agent 停用 Skill
skillbox install         安装/恢复仓库（reconcile Skill 与 Agent 链接）
skillbox install --frozen-lockfile  校验 lockfile 与 manifest 一致，不一致则失败退出
skillbox install --ci     与 --frozen-lockfile 相同，适用于 CI（无交互）
skillbox status           完整仓库状态（Repository/Skills/Agents/Git）
skillbox sync             一键同步：Scan → Detect → Secret Scan → Pull → Resolve → Commit → Push
skillbox pull             拉取远端并重新 reconcile 本地 Skills / lockfile
skillbox push             推送本地变更到远端（需先 connect）
skillbox connect          通过 GitHub Device Flow 授权并关联远端仓库
skillbox disconnect       移除本地 GitHub 授权信息（不改远端）
skillbox web              启动本地 Web UI（默认 http://127.0.0.1:43821）
skillbox -v, --version    显示版本
```

运行 `skillbox --help` 查看完整用法，`skillbox <command> --help` 查看子命令参数。

### 多设备指南（Multi-device Restore）

Skillbox 用 Git 作为多设备间的同步通道：仓库里 `skillbox.yaml` + `skillbox.lock` 描述全部 Skills 的期望状态，`npx skillbox install` 在任何一台机器上都能把仓库内容恢复成可用的本地安装。

**首次在一台新设备上使用：**

```bash
# 1) 克隆 Skill 仓库（Git 与 GitHub 授权在 connect 时完成）
git clone https://github.com/<you>/<skills-repo>.git
cd <skills-repo>

# 2) 恢复本地安装：reconcile manifest → 重建 canonical library → 链接到各 Agent
npx skillbox install
```

`install` 会恢复（restore）以下内容：

- **Local**（`local:` source）—— 校验磁盘内容与 lockfile integrity，缺失/损坏则从仓库恢复
- **Forked / Vendored** —— 按 manifest 中的来源重新检出
- **Managed**（git/github source，0.2+）—— 从远端重新下载并锁定 integrity

**同步到远端（推）：**

```bash
skillbox connect           # 首次：GitHub Device Flow 授权并绑定 origin
skillbox sync              # 之后：扫描 → 检测 → 秘钥扫描 → pull → resolve → commit → push
```

**在仓库停滞时恢复本地一致性：**

```bash
skillbox pull              # 拉取远端他人变更，重新 reconcile 并更新 lockfile
skillbox status            # 查看 Skills / Agents / Git 三块状态
```

> `sync` 只自动提交 skillbox 管理的路径（`skillbox.yaml` / `skillbox.lock` / `skills/` / `.skillbox/`），
> 不会碰你在仓库里手动添加的其他文件。推送到远端前要求 GitHub 已连接，否则命令明确报错并提示先运行 `skillbox connect`。

### 首次使用视角：一个最小例子

```bash
# 1) 进入你的 skill 仓库目录
cd ~/my-skills

# 2) 创建第一个 Skill
skillbox create my-review-skill -d "Code review skill"

# 3) 查看状态
skillbox status

# 4) 开启 Web UI 可视化（默认浏览器自动打开）
skillbox web
```

## Supported Agents

| Agent                    | 适配器                        | 状态             |
| ------------------------ | ----------------------------- | ---------------- |
| Claude Code              | `@skillbox/core` 内置 adapter | 已支持           |
| Codex                    | `@skillbox/core` 内置 adapter | 已支持           |
| Cursor                   | —                             | 规划中（0.1.1+） |
| Gemini CLI / OpenCode 等 | —                             | 规划中           |

Agent 适配器提供检测（`detect`）、扫描（`scan`）、链接（`link` / `unlink`）能力，
并上报各自的能力模型（是否支持全局 Skills、symlink、嵌套目录等）。

## Features

| 里程碑 | 能力                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0     | 项目脚手架：monorepo（pnpm workspace）、TypeScript、CI 三平台矩阵（Linux/macOS/Windows）                                                                                   |
| M1     | Core Domain：Skill 四状态（managed/forked/local/vendored）+ 六状态（ready/modified/outdated/conflict/missing/broken）领域模型、错误模型                                    |
| M2     | Filesystem：原子写、路径安全、目录扫描、Skill 校验、symlink 安全、link strategy                                                                                            |
| M3     | Manifest（`skillbox.yaml`）：schema、确定性命中序列化、增删改                                                                                                              |
| M4     | Lockfile（`skillbox.lock`）：模式、SHA-256 integrity（跨平台一致）、本地修改检测                                                                                           |
| M5     | Agent Adapter 框架 + Claude / Codex 适配器（detect/scan/link/unlink）                                                                                                      |
| M6     | Canonical Library：~/.skillbox/library、symlink 优先 + copy fallback、Import 冲突处理                                                                                      |
| M7     | Reconcile Engine：安装/恢复幂等、agent assignment、stale 清理、missing/broken 检测                                                                                         |
| M8     | Basic CLI：`list/agents/create/remove/enable/disable/install/status/web`、exit codes                                                                                       |
| M9     | 交互菜单（@clack/prompts）：第一步引导（Detect/Import/Sync）、我的 Skills、Agents、Import、Create、Web UI、Settings                                                        |
| M10    | Web Server（Hono + @hono/node-server）：health/skills/agents/status/reconcile API、端口占用回退、`web --port/--host/--no-open`                                             |
| M11    | Web 前端（React + Vite + TanStack Query）：Library / Skill Detail / Agents / Create Skill / Settings，静态资源打进 CLI 包（`pnpm build` 后 `npx skillbox web` 免单独安装） |

> 状态模型：每个 Skill 的分状态（`SkillStatus`）由 lockfile 与磁盘内容比对得出；当你在编辑器里改了 Skill 文件，`status` 会显示 `modified`，`skillbox list` 会如实反映。

## Installation

完整安装说明（系统要求、从源码构建、本地打包安装验证）见 **[INSTALLATION.md](./INSTALLATION.md)**。

系统要求一句话版：Node.js ≥ 20、pnpm、系统 Git（`sync/pull/push/connect` 与 Reconcile 依赖）。

## Roadmap

- **0.2 — Git Sync** ✅ 已落地：Git client、GitHub App device flow、私仓 transport（Credential Bridge 注入
  `sync/pull/push`）、`skillbox sync/pull/push/connect/disconnect/status`、secret scan、multi-device。
  连接状态、remote/ahead/behind 与 connect 的仓库编排（建/选私仓、`git init`、绑定 origin）由
  `@skillbox/core/sync`（RepositorySync）提供。
- **0.3 — Marketplace / Registry** ✅ 已落地：`search`、`add`、managed cache、`git:` / GitLab / Bitbucket source、
  `outdated` / `update`、Web Explore/Install/Updates；安全预览优先复用 managed cache。
- **0.4 — Skill Lifecycle** ✅ 已落地：`fork` / `vendor` / `diff` / Restore / 3-way merge（含 `--continue` / `--abort`）、
  通用 CLI/Web rollback 与操作恢复记录。
- **安全层（P1）** ✅ 已落地：安装前 Security Scan、Web 风险展示、`.skillboxignore`。
- **Hermetic CLI E2E** ✅ 已覆盖 git-free、bare remote、connect、授权失败、私仓认证失败旅程；三平台真实环境验收仍需发布前执行。
- **Fleet — 多服务器编排** ✅ 已落地：`skillbox fleet list/install/update/status` 通过 SSH 在
  `.skillbox/fleet.yaml` 配置的（或 `--ssh [user@]host[:port]` 临时指定的）远程主机上批量运行
  `skillbox install/update/status`；单台主机失败不影响其余主机，结果按主机逐行汇总。CLI 与 Web UI
  （侧栏 Fleet 页）均已接入；远程主机需预先安装 `skillbox` 与其自身的 skill 仓库。

> 权威状态清单以 **[GAP_ANALYSIS.md](./GAP_ANALYSIS.md)** 为准，本 Roadmap 只做概览。

## Architecture Summary

```
          ┌───────────────────────────────┐
          │   skillbox CLI (Commander)     │
          │   skillbox 交互 (interactive)  │
          │   skillbox web (Hono + React)  │
          └───────────────────────────────┘
                         │  共享同一套业务逻辑
          ┌──────────────▼──────────────┐
          │      @skillbox/core         │
          └──────────────▲──────────────┘
                         │
          ┌──────────────┴──────────────┐
          │  Filesystem / Agent / Runtime│
          │  Manifest / Lockfile /      │
          │  Reconcile / Library        │
          └─────────────────────────────┘
```

- **Monorepo**：`apps/web`（前端）、`packages/core`（领域与服务）、`packages/cli`、`packages/shared`、`packages/testing`
- **Single Source of Truth**：CLI / 交互 / Web 三者只允许调用 `@skillbox/core`，禁止各自实现一套逻辑

完整架构见 **[ARCHITECTURE.md](./ARCHITECTURE.md)**。

## 项目文档索引

| 文档                                               | 说明                                                |
| -------------------------------------------------- | --------------------------------------------------- |
| [PRD.md](./PRD.md)                                 | 产品需求文档（Product Requirements Document）       |
| [SKILLBOX_SPEC.md](./SKILLBOX_SPEC.md)             | 技术规格（Specification）                           |
| [ARCHITECTURE.md](./ARCHITECTURE.md)               | 架构设计（Architecture）                            |
| [MVP_TASKS.md](./MVP_TASKS.md)                     | MVP 开发任务清单（含 0.1.0 E2E 验收、发布检查清单） |
| [GAP_ANALYSIS.md](./GAP_ANALYSIS.md)               | 代码 vs 文档的差距清单                              |
| [INSTALLATION.md](./INSTALLATION.md)               | 安装/构建文档                                       |
| [CONTRIBUTING.md](./CONTRIBUTING.md)               | 贡献指南                                            |
| [docs/e2e-acceptance.md](./docs/e2e-acceptance.md) | 0.1.0 E2E 验收分步手册                              |

## CI

Linux / macOS / Windows 三平台矩阵 CI（lint + typecheck + test + build）：

[![CI](https://github.com/tzzs/skillbox/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/skillbox/actions/workflows/ci.yml)

> CI 状态来自 `tzzs/skillbox` GitHub Actions。

## Contributing

欢迎参与。请阅读 **[CONTRIBUTING.md](./CONTRIBUTING.md)**：工作流、commit 规范、测试要求。

## License

[MIT](./LICENSE)（PRD / idea 未指定协议，默认选用 MIT；如改用 Apache-2.0 等，替换 `LICENSE` 文件并在各 package 同步即可）
