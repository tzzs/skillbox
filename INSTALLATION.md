# Installation

> **Version:** 0.1
> **Last Updated:** 2026-08-09

本文档覆盖：系统要求、从源码构建、本地安装验证（`pnpm pack` + 干净目录 npx 安装）、升级说明、发布形态须知。

---

## 1. 系统要求

| 要求     | 说明                                                                  |
| -------- | --------------------------------------------------------------------- |
| Node.js  | **≥ 20**（各 package `engines.node` 声明 `>=20`）                     |
| pnpm     | 10.x（仓库锁定 `pnpm@10.25.0`，见根 `package.json` `packageManager`） |
| 操作系统 | Linux / macOS / Windows（CI 三平台矩阵全绿）                          |
| Git      | 开发 / 构建需要（`skillbox` 运行时命令不依赖系统 Git）                |
| Agent    | 本机装有 Claude Code 和/或 Codex（用于 Detect / Import / Link）       |

## 2. 从源码构建

### 2.1 安装依赖

```bash
pnpm install
```

推荐用仓库锁定的 pnpm 版本（避免与 lockfile 不一致）：

```bash
corepack enable
corepack prepare pnpm@10.25.0 --activate
```

### 2.2 质量门禁（lint / typecheck / test）

```bash
pnpm lint        # ESLint + Prettier check
pnpm typecheck   # tsc -b 全量类型检查
pnpm test        # 所有 package 单测（pnpm -r test）
```

这三个命令在 CI（`.github/workflows/ci.yml`）的 quality job 中依次运行，全部通过后才会进入 build。

### 2.3 构建

```bash
pnpm build
```

构建流程：

1. `tsc -b` 编译 packages（core/shared/testing/cli）与 apps/web 类型检查产物
2. `vite build` 构建前端 → `apps/web/dist`
3. `node scripts/package-web.mjs` 把前端静态资源复制进 `packages/cli/dist/web`
4. 因此构建后 `skillbox web` 直接提供前端页面，**无需单独安装前端**（MVP_TASKS §96）

### 2.4 从工作区运行

```bash
node packages/cli/bin/skillbox.mjs --help   # 直接运行编译产物
```

> `pnpm build` 完成后，仓库根的 `pnpm --filter @skillbox/cli ...` 或 `pnpm skillbox`（由根 `@skillbox/cli` devDependency 提供 bin）也可触发 CLI。

## 3. 本地安装验证（pack + 空目录 npx）

发布前用真实的打包产物验证「用户拿到的是什么」，而不是只用 workspace 里的可执行文件。

### 3.1 打包 @skillbox/cli

先在仓库根构建（确保 `dist` 与 `dist/web` 是最新产物）：

```bash
pnpm build
```

打包（在仓库根执行）：

```bash
pnpm --filter @skillbox/cli pack --pack-destination /tmp/skillbox-pack
```

生成 `/tmp/skillbox-pack/skillbox-cli-0.1.0.tgz`。

> 运行 `node scripts/verify-package.mjs` 可以直接验证 tgz 内容是否包含 `dist/web` 静态资源、bin 入口、打包体积等（见 §5）。

### 3.2 在空目录安装并验证

> 前提：这一步模拟「用户拿到发布包」的真实路径。当前仓库仍处于 private + workspace 依赖形态，`npm install <本地tgz>` 会因 `workspace:*` 协议被 npm 拒绝（见 §3.3）。因此该步骤应在完成发布（移除 private、将 workspace 依赖发布为版本号）后执行；在此之前，用「从工作区运行」（§2.4）等效验证同样的命令行为。

```bash
mkdir -p /tmp/skillbox-smoke && cd /tmp/skillbox-smoke
npm init -y
npm install /tmp/skillbox-pack/skillbox-cli-0.1.0.tgz
```

验证两条关键路径：

```bash
npx skillbox --help
npx skillbox web --no-open
```

**预期输出**

`npx skillbox --help` 应列出：

```text
Usage: skillbox [options] [command]

Manage the skills your AI agents use.
  Run without arguments to open the interactive menu.

Options:
  -v, --version             output the version number
  -h, --help                display help for command

Commands:
  list [options]            List every skill in the current repository
  agents [options]          Detect the configured agents and their skill counts
  create [options] <name>   Scaffold a new skill and register it with the repository
  remove [options] <name>   Remove a skill (config only by default)
  enable [options] <name>   Enable a skill for an agent
  disable [options] <name>  Disable a skill for an agent
  install                   Install/restore the repository (reconcile skills and agent links)
  status [options]          Show the full repository status (Repository, Skills, Agents)
  web [options]             Start the Skillbox web UI (default 127.0.0.1:43821)
```

`npx skillbox web --no-open` 应打印：

```text
Skillbox web UI: http://127.0.0.1:43821
  home  /home/<you>/.skillbox
```

按 `Ctrl+C` 退出。

### 3.3 已知边界（本地 tgz 的 workspace 依赖）

`@skillbox/cli` 当前依赖 `@skillbox/core` 与 `@skillbox/shared`（同为 workspace 包）。在**发布到 npm 之前**，这些依赖以 `workspace:*` 形式存在，`npm install <本地tgz>` 可能报 `Unsupported URL Type "workspace:"`。这是预期的本地开发形态 —— 发布时必须：

1. 移除各 package 的 `"private": true`（`npm publish` 会拒绝 private 包）；
2. 把 `workspace:*` 依赖发布为真实版本（`^0.1.0`）或完成后按序 publish `shared → core → cli`。

这些约束在 `scripts/verify-package.mjs` 输出中如实标注。

## 4. 升级说明

| 场景                       | 命令                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- |
| 从源码升级                 | `git pull && pnpm install && pnpm build`                                            |
| 已发布版本的升级（发布后） | 按 npm 常规方式升级，如 `npm update -g skillbox` 或 `npx skillbox@latest --version` |
| 数据兼容                   | `~/.skillbox`、`skillbox.yaml`、`skillbox.lock` 向后兼容，升级不影响既有数据        |

## 5. 发布形态验证

```bash
node scripts/verify-package.mjs
```

该脚本：

- 对 `@skillbox/cli` 执行等价于 `pack` 的内容盘点（npm pack --dry-run --json，不落盘）；
- 断言包内容包含：
  - `bin/skillbox.mjs`（bin 入口）
  - `dist/web/index.html` + `dist/web/assets/*`（M11 前端静态资源，`scripts/package-web.mjs` 的产物）
  - `dist/index.js`（CLI 主入口）
- 输出打包体积，并标注 `private` 与 workspace 依赖状态（发布阻断项 —— 不影响包内容本身，但决定能否 publish）。

退出码：`0` 内容合格；`1` 内容缺项（如未先 `pnpm build`、`dist/web` 缺失）。

## 6. 常见问题

| 现象                          | 处理                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| `npx skillbox` 找不到命令     | 未构建；先在本仓库 `pnpm build`                                     |
| `skillbox web` 打开但没有界面 | `dist/web` 缺前端产物，重新 `pnpm build`                            |
| 端口被占用                    | `skillbox web --port 0`（随机端口）或指定其它端口（M10.2 自动回退） |
| 检测不到 Agent                | 确认本机装有 Claude Code / Codex，且在其默认配置目录                |
| npm 发布报 private            | 见 §3.3 —— 发布前需移除 `private: true`                             |
