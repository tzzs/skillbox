# Skillbox 功能差距清单（Gap Analysis）

> 对照 `PRD.md`、`SKILLBOX_SPEC.md`、`ARCHITECTURE.md`、`MVP_TASKS.md`、
> `docs/superpowers/specs/2026-08-09-github-integration-design.md` 与当前代码。
>
> 当前代码基线：`03a48f5`（2026-08-12，PR #2 合并后）加本工作区的 Managed Restore
> 变更（2026-08-13，尚未提交）。
>
> 本次更新（2026-08-13）基于一次完整的 install / lint / typecheck / test / build 验证
> （见 §10），已将 PR #2 落地的 GitHub 默认接线与仓库同步能力从 P0 清单移入
> “已落地基线”，并核对了 Web / CLI 剩余缺口。
>
> 本文只把当前代码中仍未闭环的能力列为缺口。旧版清单中已经实现的项目已移至“已落地基线”，
> 避免将过时 TODO、历史注释或仅有测试替身的能力误判为当前状态。

---

## 1. 当前已落地基线

### 1.1 Local Management

- Skill 四种模式：Managed / Forked / Local / Vendored
- Skill 六种状态：Ready / Modified / Outdated / Conflict / Missing / Broken
- Manifest 与 Lockfile schema、确定性序列化、完整性一致性检查
- SHA-256 canonical integrity、`.gitattributes`、跨平台换行归一化
- Canonical Library、ownership marker、symlink / junction / copy link strategy
- Import Existing Skills、冲突处理、Agent link 迁移
- Reconcile Engine、本地与 Git/GitHub source materialize、stale link 清理
- `install --frozen-lockfile` / `install --ci`

### 1.2 Agent 与交互入口

- Claude Code、Codex、Cursor adapters
- Agent detect / scan / link / unlink 与 capability model
- Basic CLI、Interactive CLI、Web UI 三种入口
- 交互菜单的 “Open Web UI” 已接入真实 Web server，不再是占位项
- Web Settings 已支持 link strategy、Web port、自动打开浏览器、Agent path override
- Agents 页面可跳转到按 Agent 过滤的 Library
- Create Skill 页面支持创建时分配多个已检测 Agent
- CLI `--verbose` / `--debug` 与日志脱敏基础设施

### 1.3 Git、Marketplace、安全与 Lifecycle 核心模块

- Core GitClient：init/status/pull/push/commit/diff/fetch/checkout/materialize
- Core GitHub：Device Flow、TokenStore、跨平台 Credential Store、Repository create/select、Credential Bridge
- Secret Scan、`.skillboxignore`、安装前静态安全扫描与高风险确认
- Registry framework：GitHub / skills.sh / Local providers
- Managed cache、事务式 remote install、rollback-on-failure
- CLI `search/add/outdated/update/cache clean`
- Fork / Vendor / managed modification detection / Base Snapshot
- Managed / Forked Diff
- 3-way Merge、冲突状态、`--continue`、`--abort`、merge 前备份
- Web Explore、Install、Updates、Diff 页面

### 1.4 当前 CLI 命令面

```text
list / agents / create / remove / enable / disable / install / status
sync / pull / push / connect / disconnect
search / add / outdated / update / cache clean
fork / vendor / edit / diff / merge
web
```

### 1.5 GitHub 默认接线与仓库同步闭环（PR #2，2026-08-12）

- 默认 GitHub production factory：Client ID、GitHubApi、CredentialStore、TokenStore、
  RuntimeConfigService 组装，`SKILLBOX_GITHUB_CLIENT_ID` 环境变量可覆盖 Client ID
- CLI GitHub adapter 与 Core result shape 的映射（含 Device Flow 秒/毫秒换算、
  slow-down / failed 状态透传）
- GitClient remote introspection：`status()` 返回真实 `ahead` / `behind` / `remote`，
  覆盖无 remote、detached HEAD、分支无 upstream 等边界
- `RepositorySyncService`（Core）：authorize → repository → init → bind-remote →
  persist → pull → push 全阶段编排；CLI `connect` / `disconnect` 已路由到 Core
- 私仓 Git transport：Credential Bridge 无落盘凭据注入 + 禁止 hook 读取传输凭据
- 默认 production wiring 集成测试（GitHub / Git / repository sync 错误码覆盖）

### 1.6 Managed Restore（工作区变更，2026-08-13）

- Core `restoreManagedSkill()` 只接受 Managed skill，读取其锁定 revision 与 integrity，且不改写
  Manifest / Lockfile
- 从已验证的 managed cache 复制到同级 staging 目录，验证 canonical integrity 后替换 runtime；失败时
  保留或恢复原 runtime，并返回稳定的 rollback 错误
- CLI Lifecycle adapter 传递 `homeRoot`，交互式 `skillbox edit` 的已修改 Managed Skill 可以选择
  **Restore**；恢复后回到 pristine managed 状态
- 已有 Core Restore、CLI adapter 和 interactive service 的定向测试；当前实现暂只支持已缓存的
  GitHub source，尚未成为统一 Source/下载恢复能力

---

## 2. P0 — 当前无已确认的主流程阻断项

此前唯一 P0（Managed Restore）已在当前工作区实现并通过定向验证，见 §1.6。该结论仅覆盖
**已缓存的 GitHub Managed skill**：首次下载、其他 source 以及跨平台端到端验收仍属于后续 P1
工作，不能据此宣称发布就绪。

---

## 3. P1 — 产品能力未闭环

### 3.1 Marketplace 与 Manifest Source 模型不一致

Manifest 支持：

```text
github / git / registry / local
```

Marketplace 的 `NormalizedSource` 当前只支持：

```text
github / skills-sh / local
```

已知限制：

- `git:`、SSH、GitLab、Bitbucket source 被 `parseSource()` 明确拒绝
- `outdated/update` 只映射 GitHub 和 Local lockfile source
- `registry` source 不能通过 Reconcile Git engine materialize
- `git` source 虽可由 Reconcile 克隆，但不能通过统一 `add/search/update` 流程安装和升级
- CLI Marketplace 与 Web Registry 各自有 provider 注册/适配代码，尚未完全统一

待实现：统一 Source Domain 与 Provider dispatch，使 add/install/reconcile/outdated/update/diff/merge
对同一种 source 具有一致行为。

### 3.2 Web 与 CLI Lifecycle 能力不对等

Web 当前已提供 Skill Diff，但尚未提供以下操作：

- Fork
- Vendor
- Edit / Restore
- Merge
- Merge Continue / Abort
- Rollback

需要补充 Core-backed Web APIs、风险确认、事务结果展示和对应 React UI。Web 层不应重新实现
Lifecycle 逻辑。

### 3.3 Rollback 用户功能未实现

安装事务失败的内部 rollback 已存在，merge 也支持 abort；但 PRD Roadmap 中面向用户的通用
rollback 尚无 Core service、CLI 命令或 Web UI。

需要先定义 rollback 的对象和范围：

- Skill 内容版本
- Manifest / Lockfile
- Agent assignment
- Fork / Vendor / Restore 等生命周期操作

### 3.4 配置模型仍与 SPEC 有差异

当前 Runtime Config：

- `web` 只有 `port` / `open`，缺 `web.host`
- Agent override 使用单个 `path`，而 SPEC 规划 `skillDirectories: string[]`

兼容性设计需要考虑现有 `config.json`：新增字段时应提供 schema migration 或向后兼容解析，
不能直接破坏现有机器配置。

### 3.5 Logging 尚未贯穿主要业务流水线

Logger、verbosity level、脱敏与 CLI flags 已落地，但多数 Core/CLI 流程没有输出结构化 debug
事件。当前日志更接近基础设施，而不是完整的诊断能力。

待实现：

- Sync / Install / Reconcile / Registry / Lifecycle 的关键步骤日志
- 错误 context 的统一脱敏
- 可导出的 debug bundle
- debug bundle 中 token、authorization header、remote credential 的自动校验

---

## 4. P1 — 可靠性与架构基础设施

### 4.1 `runtime.lock` 并发保护

尚无进程级运行锁。多个 CLI/Web 操作同时写 Manifest、Lockfile、library 或 merge state 时，仍有
相互覆盖风险。

至少应覆盖：install、sync、add、update、fork、vendor、restore、merge、remove。

### 4.2 Schema Migration

Manifest / Lockfile 虽有版本字段，但没有：

- migration registry
- 自动迁移策略
- `skillbox migrate`
- 旧版 fixture 回归测试

Runtime Config 的后续字段变化也应纳入迁移或兼容读取策略。

### 4.3 Backup 机制只覆盖部分流程

当前 merge 有 pre-merge backup，但以下场景尚无统一备份策略：

- Remove modified skill
- Vendor
- Restore Managed（已有同级 backup，但尚未纳入统一 backup service）
- 通用 Rollback
- destructive migration

需要建立统一 backup service、保留策略、清理策略与恢复命令。

### 4.4 Event Bus / Progress Model

架构规划的 Event Bus 尚未实现。当前 CLI/Web 主要直接调用服务并等待结果，缺统一的：

- Download progress
- Install lifecycle events
- Git sync events
- Security finding events
- Web/TUI 实时进度订阅

### 4.5 Doctor 与 Debug Bundle

仍缺：

- `skillbox doctor`
- Git / Node / Agent / link capability 检查
- Credential Store / Secret Service 可用性检查
- Repository/Manifest/Lockfile/library/link state 一致性诊断
- 脱敏 debug bundle

---

## 5. P2 — Agent、交互与分发扩展

### 5.1 Agent 覆盖面

已实现 Claude、Codex、Cursor；尚未实现：

- Gemini CLI
- OpenCode
- Windsurf
- GitHub Copilot

新增 adapter 时应复用 capability model，并覆盖 detect/scan/link/unlink、path override 与 copy
fallback 测试。

### 5.2 Fullscreen TUI

当前 `@clack/prompts` Interactive CLI 已满足 MVP；独立 Fullscreen TUI 仍未实现，但
`MVP_TASKS.md` 明确允许 V0.1 不做复杂 TUI，因此不是近期发布阻断项。

### 5.3 独立 Web Server package

架构建议的 `packages/web-server` 尚未拆分，当前 Hono server 位于 CLI package。现状可用，只有在
需要独立部署、复用或插件化时再拆分，不应优先于 P0 主流程。

---

## 6. 发布与验收缺口

### 6.1 npm 发布配置

Root、CLI、Core 等 package 仍设置 `"private": true`。正式发布前至少需要：

- 明确公开包名与发布范围
- 移除需要发布 package 的 `private`
- workspace dependency 发布转换验证
- `files` / bin / bundled Web assets 检查
- provenance、repository、homepage、bugs、license metadata
- `pnpm pack` 后的干净环境安装测试

### 6.2 README / Release Metadata

- README CI badge 仍使用 `OWNER/REPO` 占位
- README 的 GitHub Sync 描述与代码已一致（connect 全链路已闭环，见 §1.5），
  可将 README Roadmap 0.2 中的“依赖 GitHub Device Flow 后端落定”说明移除
- `GAP_ANALYSIS.md` 更新后，README Roadmap 应同步使用相同状态口径

### 6.3 E2E 验收与自动化

`docs/e2e-acceptance.md` 的十步验收仍未记录完成结果，仓库也没有 Playwright/Cypress 或等价的
端到端测试层。

建议分为两层：

1. Hermetic CLI E2E：临时 HOME、临时 Git remote、fake registry、真实进程执行。
2. Manual platform acceptance：Windows/macOS/Linux 上真实 Agent 目录、link strategy、浏览器与
   Credential Store。

必须覆盖的真实主路径：

```text
detect → import → create → assign → reconcile → status
connect → repository bind → sync → second-device clone → install
search → security review → add → outdated → update
managed edit → fork/restore → diff → merge/continue/abort
```

---

## 7. 文档与代码债务

### 7.1 过时注释

代码中仍有多处 “agent N 尚未落地”“not landed yet” 注释，但对应 Core 模块已经存在，例如 Diff、
Merge、GitClient、GitHubService、Registry 与 Security Scanner。

这些注释应在完成真实接线检查后清理，避免：

- 将已实现能力误判为缺失
- 掩盖“模块已存在但 adapter 不兼容”的真实问题
- 让后续开发继续依赖过时的接口预期

### 7.2 重复 Adapter 与动态导入

CLI Sync 已随 §2.1/§2.2 落地改为显式 typed factory，并补上默认 production wiring 测试；
但 Marketplace 与 Lifecycle 仍使用动态导入和结构类型转换，Sync 中 Git / SecretScanner 的
`loadCore` 兼容缝也仍保留。

建议在各模块稳定后：

- 将 Marketplace / Lifecycle 改为显式 typed factory
- 删除 runtime arity check 和宽泛 `Record<string, unknown>` 转换
- 补齐 Marketplace / Lifecycle 的“默认 production wiring”测试
- 保留依赖注入接口供测试使用

---

## 8. 明确非近期范围

以下仍按 PRD Non-goals / 长期规划处理，不列为当前版本阻断项：

- 自建中心化 Registry
- SaaS 云盘 / Remote Dashboard
- Team / Billing / RBAC / Cloud Database
- 强制桌面客户端
- 新 Skill 标准
- MCP / Rules / Prompts / Hooks 统一管理
- AI 自动生成 Skill
- Plugin marketplace

---

## 9. 建议实施顺序

### Wave 1 — 恢复真实主流程

> 本波已完成：PR #2 的 GitHub/Git 主流程（§1.5）以及当前工作区的 Managed Restore（§1.6）。
> Restore 仍需纳入统一事务与多 source 支持，见 Wave 3。

### Wave 2 — 建立可信验收

1. Hermetic CLI E2E
2. 三平台 manual acceptance
3. 更新 README 的功能状态

### Wave 3 — 产品能力闭环

1. 统一 Marketplace / Manifest Source 模型
2. Web Fork/Vendor/Edit/Restore/Merge
3. 通用 Backup / Rollback
4. runtime lock 与 schema migration

### Wave 4 — 发布与扩展

1. npm pack / publish 配置
2. doctor / debug bundle / Event Bus
3. Gemini / OpenCode 等 Agent adapters
4. 视需求拆分 Web Server 或实现 Fullscreen TUI

---

## 10. 本次验证说明（2026-08-13）

本次更新完成了完整验证链：

```text
pnpm install --frozen-lockfile   ✅ 227 packages
pnpm lint                        ✅ eslint + prettier 全部通过
pnpm typecheck                   ✅ tsc -b + web typecheck 通过
pnpm test                        ✅ 947 tests（core 662 / cli 275 / web 8 / shared 1 / testing 1）
pnpm build                       ✅ tsc + vite web bundle + web assets 打包
```

已知注意点：

- `reconcile > reconciles a git source idempotently and refreshes when the remote
advances`（`packages/core/src/reconcile/engine.test.ts:281`）在整仓并行跑测试时偶发
  30s 超时；单独运行 3.4s 通过。原因是该用例串行执行 3 次真实 git clone/pull，在并行负载高
  的环境（Windows）下容易超预算，属于环境抖动而非逻辑失败，复跑整仓测试全部通过。若 CI 仍
  偶发，可考虑提高该用例 timeout 或将 git 类用例串行化。

当前工作区的 Managed Restore 追加定向验证：

```text
pnpm --filter @skillbox/core test -- restore.test.ts                         ✅ 3 tests
pnpm --filter @skillbox/cli test -- skill-lifecycle/loaders.test.ts \
  skill-lifecycle/service.test.ts                                            ✅ 38 tests
pnpm typecheck                                                               ✅
```

这些结果不替代首次下载、非 GitHub source、真实 Agent link 或三平台 E2E 验收。
