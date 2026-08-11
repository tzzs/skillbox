# Contributing

> **Version:** 0.1
> **Last Updated:** 2026-08-09

感谢你对 Skillbox 的关注。本文件说明开发工作流、commit 规范、测试要求与目录结构。

---

## 1. 开发工作流

### 1.1 分支策略

- 默认从 `main` 拉出**功能分支 / 修复分支**，命名建议：
  - `feat/<short-description>`（新功能）
  - `fix/<short-description>`（缺陷修复）
  - `docs/<short-description>`（文档）
  - 例：`feat/github-sync`、`fix/windows-junction`、`docs/e2e-acceptance`
- 完成 + 自测通过后，创建 Pull Request 到 `main`。
- PR 由 CI（lint / typecheck / test / build 三平台矩阵）把关，全绿后才可合并。

### 1.2 Commit 规范

沿用仓库既有风格（`feat:` / `fix:` / `docs:` + `Co-Authored-By`）：

```text
feat: add skillbox sync command
fix: resolve symlink containment check on Windows
docs: add 0.1.0 E2E acceptance manual
```

- 与 AI 协作编写时，保留 `Co-Authored-By` trailer（与协作 Agent 署名一致）。
- 一条 commit 只做一件事；描述「为什么 / 改了什么」，而非流水账。
- 保留 `Co-Authored-By: <Agent> <agent@example.com>` 或按仓库惯例署名。

示例（参考现有历史）：

```text
feat: M9 interactive CLI, M10 web server, M11 web UI

- interactive mode via @clack/prompts ...
- web server ... static assets packaged into the CLI dist
- wire web subcommand handler ...

Co-Authored-By: Claude <noreply@anthropic.com>
```

### 1.3 提交流程

```bash
git checkout -b feat/your-feature
# ... 修改代码 / 文档 ...
pnpm lint
pnpm typecheck
pnpm test
git add .
git commit -m "feat: your change"
```

## 2. 测试要求

- **必须**在改动相关的 package 内补充 / 更新测试，所有测试用 vitest 编写。
- 提交前跑完整质量门禁（与 CI 相同）：

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test
  ```

- 涉及核心领域逻辑（manifest / lockfile / integrity / reconcile）时，为关键路径补单测，避免回归。
  - 例：`packages/core/src/...`、`packages/cli/src/interactive/session.test.ts` 等既有测试模式。
- 新文档中的命令/输出**必须真实可执行**（仓库 CI 不校验文档，但维护者会抽查）。

## 3. 目录结构

```text
skillbox/
├── apps/
│   └── web/                  # React + Vite 前端（M11）
│       ├── dist/             # 构建产物（被打进 CLI 包的 dist/web）
│       └── src/
├── packages/
│   ├── core/                 # 领域与服务（Skill/Manifest/Lockfile/Reconcile/Agent/...）
│   ├── cli/                  # CLI + 交互菜单 + web 服务（Commander/@clack/Hono）
│   │   ├── bin/skillbox.mjs
│   │   └── src/web/          # Web server（M10）
│   ├── shared/               # 共享工具
│   └── testing/              # 测试工具/工厂
├── scripts/
│   ├── package-web.mjs       # 前端资源打进 CLI 包
│   └── verify-package.mjs    # 发布形态验证
├── docs/
│   └── e2e-acceptance.md     # 0.1.0 E2E 验收手册
├── ARCHITECTURE.md           # 架构设计
├── GAP_ANALYSIS.md           # 代码 vs 文档差距清单
├── MVP_TASKS.md              # MVP 开发任务（含发布检查清单）
├── PRD.md                    # 产品需求文档
└── SKILLBOX_SPEC.md          # 技术规格
```

> 规则：CLI / 交互 / Web 前端**不得各自实现业务逻辑**，一律复用 `@skillbox/core`。

## 4. 发布流程（Owner）

1. 跑 `node scripts/verify-package.mjs` 确认发布形态（含 `dist/web`）。
2. 跑通 `docs/e2e-acceptance.md` 的 0.1.0 E2E 验收 10 步。
3. 移除各 package 的 `"private": true`，发布 `shared → core → cli`（先行顺序）。
4. 在 GitHub 打 `v0.1.0` tag，并生成 Release Notes。
