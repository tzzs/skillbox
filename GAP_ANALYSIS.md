# Skillbox 功能差距清单（Gap Analysis）

> 对照 `PRD.md`、`SKILLBOX_SPEC.md`、`ARCHITECTURE.md`、`MVP_TASKS.md`、
> `docs/superpowers/specs/2026-08-09-github-integration-design.md` 与当前代码。
>
> 当前代码基线：`375411d`（2026-08-12）。
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

---

## 2. P0 — 主流程阻断项

### 2.1 GitHub Service 已实现，但默认 CLI adapter 接口不匹配

这是当前最重要的缺口。

CLI 的 `packages/cli/src/sync/loaders.ts` 仍按旧的预期接口工作：

```ts
new GitHubService(homeRoot)
service.connectionState()
service.startDeviceFlow()
service.pollDeviceFlow()
```

Core 的实际接口位于 `packages/core/src/github/github-service.ts`：

```ts
new GitHubService({ clientId, api, tokenStore, configStore, ... })
service.getConnectionState()
service.startDeviceAuthorization()
service.pollDeviceAuthorization()
```

因此 Core 单元能力虽已存在，默认的以下用户流程仍未真正可用：

- `skillbox connect`
- `skillbox disconnect`
- `skillbox sync` 的 GitHub connected gate
- `skillbox push` 的 GitHub connected gate

待实现：

- GitHub production factory：Client ID、GitHubApi、CredentialStore、TokenStore、RuntimeConfigService
- CLI contract 与 Core result shape 的转换
- Device Flow 秒/毫秒与状态对象的明确映射
- 默认构建的集成测试，不能只使用 fake `GitHubProvider`

### 2.2 Git remote、ahead/behind 与仓库绑定未闭环

当前 `GitClientAdapter.status()`：

- `ahead` 固定为 `0`
- `behind` 固定为 `0`
- 不返回 `remote`

而 `SyncService.pull()` / `push()` 依赖 `status.remote` 判断远端是否存在。这会导致真实仓库的
status 不准确，并可能让 pull/push 错误报告 `GIT_REMOTE_NOT_FOUND`。

`skillbox connect` 当前也只负责授权，没有完成：

- 创建或选择 `skillbox-skills` 私有仓库
- 将选择结果写入 GitHub machine config
- 初始化本地 Git repository（需要时）
- 添加或更新 `origin`
- 将 Credential Bridge 注入 Git fetch/pull/push
- 验证 private repository 的 clone/pull/push

待实现：

- GitClient remote introspection 和 ahead/behind 计算
- GitProvider status shape 的真实映射
- connect 后的 repository orchestration
- 私仓 Git transport 的无落盘凭据注入
- 从零开始的 connect → sync → clone → install 端到端测试

### 2.3 Managed Restore 未实现

`skillbox edit` 已能检测 Managed Skill 的本地修改，并支持 Convert to Fork；但 Restore Upstream
分支依赖的 `restoreManagedSkill()` 没有 Core 实现。

当前 CLI adapter 会返回 `LIFECYCLE_UNAVAILABLE`，建议用户改为 fork 或重新 install，尚未满足
SPEC 中 `[Convert to Fork] / [Restore Upstream]` 的完整交互。

待实现：

- `restoreManagedSkill(alias, options)` Core transaction
- Restore 前备份
- 重新 materialize pinned upstream
- integrity、lockfile、Agent link 一致性恢复
- 中途失败 rollback
- CLI 与 Interactive CLI 集成测试

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
- Restore Managed
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
- README 对 GitHub Sync 的描述需在默认接线完成后才能标记“完整可用”
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

CLI Sync、Marketplace、Lifecycle 使用大量动态导入和结构类型转换。它帮助并行开发阶段解耦，
但现在已经产生接口漂移，例如 GitHub Service。

建议在各模块稳定后：

- 改为显式 typed factory
- 删除 runtime arity check 和宽泛 `Record<string, unknown>` 转换
- 增加“默认 production wiring”测试
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

1. 修复 GitHub production factory 与 CLI adapter
2. 实现 Git remote/ahead/behind introspection
3. connect 时创建/选择仓库并绑定 origin
4. Credential Bridge 接入 Git transport
5. 实现 Managed Restore

### Wave 2 — 建立可信验收

1. 默认 production wiring integration tests
2. Hermetic CLI E2E
3. 三平台 manual acceptance
4. 更新 README 的功能状态

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

## 10. 本次验证说明

本次审查完成了代码、配置、命令、Web route、TODO 与测试文件的静态核对。

尝试执行：

```text
pnpm typecheck
```

当前 checkout 没有安装 `node_modules`，命令因找不到 `tsc` 退出，因此本次没有获得可确认的
typecheck/test/build 结果。该失败表示依赖未安装，不表示已经发现 TypeScript 编译错误。

下一次形成发布结论前应执行：

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
