# Skillbox 功能差距清单（Gap Analysis）

> 对照 `PRD.md`、`SKILLBOX_SPEC.md`、`ARCHITECTURE.md`、`MVP_TASKS.md`、
> `docs/superpowers/plans/2026-08-12-gap-optimization-roadmap.md` 与当前代码。
>
> 当前代码基线：`03a48f59`（master，2026-08-14 工作区）。上一版基线 `375411d`。
>
> 本文只把当前代码中仍未闭环的能力列为缺口。旧版清单中已经实现的项目已移至“已落地基线”，
> 避免将过时 TODO、历史注释或仅有测试替身的能力误判为当前状态。
>
> 本文依据本次静态核对 + 真实执行（typecheck / lint / test / build）结果更新，结论见 §9。

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
- 交互菜单的 “Open Web UI” 已接入真实 Web server
- Web Settings 已支持 link strategy、Web port、自动打开浏览器、Agent path override
- Agents 页面可跳转到按 Agent 过滤的 Library；Create Skill 支持分配多个已检测 Agent
- CLI `--verbose` / `--debug` 与日志脱敏基础设施

### 1.3 Git、GitHub、Marketplace、安全与 Lifecycle 核心模块

- Core GitClient：init/status/pull/push/commit/diff/fetch/checkout/materialize、gitVersion、isInstalled
- **Git remote / upstream / ahead / behind 真实 introspection**（`trackingStatus`：`rev-list --left-right --count HEAD...@{upstream}`、
  `configuredRemote` 优先 origin、`getRemote` / `addRemote` / `removeRemote`）
- Git 错误映射：`GIT_NOT_FOUND`、`GIT_AUTH_FAILED`、`GIT_PUSH_REJECTED`、冲突态、detached HEAD
- Core GitHubService：Device Flow、TokenStore、Credential Store、跨平台 Credential Store、Repository create/select、
  Credential Bridge（`getGitTransportAuth`，token 不进 argv/env/remote URL/日志）
- **GitHub production wiring**：`createProductionGitHubProvider` / `createDefaultGitHubProvider`
  （`packages/cli/src/sync/loaders.ts`）强类型适配 `GitHubService.getConnectionState / startDeviceAuthorization /
pollDeviceAuthorization / disconnect`；默认 wiring integration tests 已存在（`sync/pipeline.test.ts`）
- **Core RepositorySync module**（`packages/core/src/sync/repository-sync.ts` + `factory.ts`）：
  `connect`（Device Flow → 当前用户 → 创建/选择私仓 → 需要时 `git init` → 绑定/校验 origin → 持久化，失败回滚 remote add）、
  `disconnect`、`pull` / `push`（注入 `GitTransportAuth`、首次 push `--set-upstream`）、`status` / `sync`
- CLI `connect` / `disconnect` 已走 Core RepositorySync（无 provider override 时），Device Flow 交互输出正常
- **CLI sync / pull / push 已接入 RepositorySync（Credential Bridge）**：`createSyncGitTransport` 把
  `RepositorySync.pull/push` 适配为 CLI transport 契约并注入 `SyncService`；未连接 GitHub 时 pull 回退到
  普通 git（公开 remote 可用），连接后私仓 fetch/pull/push 使用无落盘凭据
- Secret Scan、`.skillboxignore`、安装前静态安全扫描与高风险确认
- Registry framework：GitHub / skills.sh / Local providers；Marketplace 默认 provider 注册（update 不依赖 search/outdated 预热）
- Managed cache、事务式 remote install、rollback-on-failure
- CLI `search/add/outdated/update/cache clean`
- Fork / Vendor / managed modification detection / Base Snapshot
- **Managed Restore（M17.3 `[Restore]`）**：`restoreManagedSkill`（`packages/core/src/lifecycle/restore.ts`）——
  校验锁定的 pin → 恢复前 recovery snapshot（`~/.skillbox/state/backups/restore/`）→ 重新下载 pinned revision →
  结构/integrity 校验（对照 lockfile）→ 原子替换 library 副本 → 刷新 Agent links（copy 策略 stale 项强制重建）→
  失败完整回滚；`skillbox edit` 的 [Restore] 分支已接通（`LIFECYCLE_UNAVAILABLE` 不再触发）
- 3-way Merge、冲突状态、`--continue`、`--abort`、merge 前备份
- Web Explore、Install、Updates、Diff 页面
- **Hermetic CLI E2E harness**（`packages/testing/src/cli-harness.ts`）：真实 CLI 子进程 + 临时
  `SKILLBOX_HOME`/仓库；git-free 旅程（version / create→list→remove / install / 未知命令）已在
  `packages/testing/src/e2e.test.ts` 通过；CI build 后运行 `pnpm test:e2e`

### 1.4 当前 CLI 命令面

```text
list / agents / create / remove / enable / disable / install / status
sync / pull / push / connect / disconnect
search / add / outdated / update / cache clean
fork / vendor / edit / diff / merge
migrate / rollback / doctor
web
```

### 1.5 当前 Web API 面（M10 JSON API）

```text
GET  /api/health
GET  /api/skills | /api/skills/:id | /api/skills/:id/content | /api/skills/:id/diff
POST /api/skills | /api/skills/:id/enable | /api/skills/:id/disable | /api/reconcile
POST /api/skills/:id/fork | /api/skills/:id/vendor | /api/skills/:id/restore | /api/skills/:id/merge
PUT  /api/settings | /api/skills/:id/content
DELETE /api/skills/:id
GET  /api/registry/search | /api/registry/outdated
POST /api/registry/install
GET  /api/rollbacks | POST /api/rollbacks/:id/restore
```

---

## 2. P0 — 主流程阻断项

### 2.1 ✅ Managed Restore 已实现（2026-08-14）

`restoreManagedSkill`（`packages/core/src/lifecycle/restore.ts`，M17.3 `[Restore]`）已闭环并接入
`skillbox edit` 的 Restore 分支：

- 前置校验：manifest 存在（`SKILL_NOT_FOUND`）、模式为 managed（`LIFECYCLE_ILLEGAL_TRANSITION`）、
  lockfile 含 `revision` + `integrity`（`RESTORE_FAILED`）、source 有 registry 表示（`SOURCE_UNSUPPORTED`）
- 已与 lockfile 一致时幂等 no-op（`unchanged: true`）
- 恢复前 recovery snapshot → `~/.skillbox/state/backups/restore/<alias>-<ts>`（成功保留、失败清理）
- 重新下载 **pinned revision**（provider.download(locked.revision)），结构校验（SKILL.md / skillbox.yaml）、
  integrity 对照 lockfile（不一致 → 可恢复的 `INTEGRITY_MISMATCH`）
- 原子替换 managed library 副本；刷新 Agent links（copy 策略 stale 项强制重建，blocked 外部条目报错）
- 中途失败 rollback：恢复原 runtime、清理下载与备份
- 测试：`restore.test.ts` 10 例（含 rollback / integrity / no-op / 缺 pin 等）；CLI loader 映射
  `{ name, filesRestored }` 并更新过时注释

### 2.2 ✅ CLI sync / pull / push 已接入 RepositorySync（Credential Bridge）

`createSyncGitTransport`（`packages/cli/src/sync/loaders.ts`）把 Core `RepositorySync.pull/push`
适配为 CLI `SyncGitTransport` 契约并注入 `SyncService`（`program.ts` 生产 wiring）：

- `skillbox sync` / `pull` / `push` 的 git 传输现在经过 RepositorySync：已连接 GitHub 时
  `getGitTransportAuth()` 注入 fetch/pull/push（私仓可用），未连接时 pull 回退到普通 git（公开 remote 行为不变）
- 冲突仍以 `GitPullOutcome` 形状返回，pipeline 保持 typed `GIT_CONFLICT` 错误
- 测试：`loaders.test.ts` 8 例（委托、冲突回读、GITHUB_NOT_CONNECTED 回退、SyncService 路由）

剩余小项（roadmap 1.1 未勾选项，低优先）：

- Interactive CLI（`interactive/session.ts`）仍直接用旧 `SyncService` 而非 RepositorySync interface
- `SyncService.connect/disconnect` 保留为无 RepositorySync 注入时的 legacy fallback（生产默认路径已走 RepositorySync）

### 2.3 Hermetic E2E 部分落地（git-free 旅程已跑通）

`packages/testing/src/cli-harness.ts`：真实 CLI 子进程（`node packages/cli/bin/skillbox.mjs`）+ 临时
`SKILLBOX_HOME`/仓库；`packages/testing/src/e2e.test.ts` 的 git-free 旅程已通过：
`--version` / `create → list → remove` / `install` / 未知命令。根脚本 `pnpm test:e2e`，CI build 后执行；
CLI 未构建时套件自跳过并提示。

仍缺（roadmap 1.4 / 3.2 未勾选项）：

- `connect → repository bind → sync → push`、`clone → connect/install → pull` 等 git/网络旅程
- bare Git remote fixture、controlled GitHub/Registry HTTP server fixture
- authorization timeout/cancel/retry、private remote auth failure 场景
- 三平台 manual acceptance 证据（§6.3）

---

## 3. P1 — 产品能力未闭环

### 3.1 Marketplace 与 Manifest Source 模型（部分统一，2026-08-14）

已落地：

- **`git:` 与 scp-style（`git@host:path`）source 已支持**：`parseSource` 不再拒绝；`NormalizedSource`
  新增 `git` 类型；`toManifestSource` / `fromManifestSource` 完整 round-trip（`git` 不再返回 `null`）
- **新增 `GitSourceProvider`**（`packages/core/src/registry/git.ts`）：`git ls-remote` 把 ref/HEAD 钉到
  commit SHA、clone-or-checkout 后把 skill 子树写入下载目录；已注册进默认 provider（CLI marketplace）
  —— `add` / `install` / `update` / `restore` 对 `git:` source 走统一流程
- **install 下载目录契约修复**：真实 provider（github / skills-sh / git / local）都把子树写入 `targetDir`，
  install 不再二次解析 `source.path`（原实现与真实 provider 冲突，带 path 的 github source 实际会安装失败）；
  source path 的 `../` 穿越改为在下载前做可移植性校验
- **cache 条目纯净化**：`.integrity` 标记移到条目旁文件（`<revision>.integrity`），缓存内容可直接参与哈希
- **转换统一**：install 用 `toManifestSource`、marketplace 用 `fromManifestSource`（删除重复实现）；
  `git` source 的别名派生、描述、cache key、CLI 展示均已覆盖

已补齐（2026-08-14 第六轮）：

- **Reconcile 对 registry（skills.sh）source 回退 provider**：`ReconcileOptions.registry`（默认
  process-wide `defaultRegistry`）——git engine 无法规划的 registry 条目经 `resolve → download`
  物化（子树契约），fresh clone 上 skills.sh 技能不再被静默跳过；无 provider 时给出可操作的
  `skillbox add` 提示（`skipped`）
- **`gitlab:` / `bitbucket:` scheme 简写**：映射为 `git:` URL（`gitlab:org/repo` →
  `https://gitlab.com/org/repo`），`ssh:` / `file:` 仍明确拒绝

残余（债务类，非功能缺口）：

- CLI Marketplace 与 Web Registry 的 provider 注册/适配代码仍未完全统一（共用 core
  defaultRegistry，主要是 loader 层重复，roadmap 4.2 调用方迁移）

### 3.2 ✅ Web 与 CLI Lifecycle 能力不对等（已闭环，2026-08-14）

Web 已补齐全部 lifecycle 操作（§1.5 路由清单已更新）：

- **API**：`POST /api/skills/:id/fork`（M17.1）、`/vendor`（M18）、`/restore`（M17.3）、
  `/merge`（M20，body `{action: 'merge'|'continue'|'abort'}`）——全部走 Core 事务
  （`forkSkill` / `vendorSkill` / `restoreManagedSkill` / `mergeSkill` / `continueMerge` / `abortMerge`），
  错误经 M10.8 信封映射（`LIFECYCLE_ILLEGAL_TRANSITION` 等 → 409）
- **Web mutation 锁**：全部 8 个 mutating 路由（create/content/delete/enable/disable/reconcile/
  install/settings）与 4 个 lifecycle 路由都经 `mutation(services, …)` 走跨进程 `mutation` 锁（§4.1）
- **UI**：Skill Detail 新增 Lifecycle 卡片——按 mode/status 状态机给出动作
  （managed → Fork/Restore/Vendor/Merge；forked → Vendor/Merge；conflict → Continue/Abort），
  确认后执行并渲染结果（合并冲突列出文件，提示继续/中止）
- 测试：web/app.test.ts +5（真实 Core fork/vendor/restore 事务、merge 路由、错误信封）
- 顺带：web services 注册 `GitSourceProvider`；web 错误映射补 lifecycle/merge/restore/lock 状态码

### 3.3 ✅ 面向用户的 Rollback 已实现（2026-08-14）

通用 backup/rollback 已闭环（roadmap 2.4）：

- **统一 BackupService**（`packages/core/src/backup/`）：索引
  `~/.skillbox/state/backups/index.json` + 独立备份目录；`record` / `list` / `get` / `forget` /
  `rollback` / `prune`（保留策略：每个 operation+alias 保留最新 N 份，默认 10）
- **rollback 语义**：`kind: 'runtime'`（恢复 library 副本）与 `kind: 'repo-dir'`（恢复仓库目录）；
  拒绝未知 id（`BACKUP_NOT_FOUND`）、内容缺失（`BACKUP_INCOMPLETE`）、跨仓库（`BACKUP_REPOSITORY_MISMATCH`）
- **接线**：`restoreManagedSkill` 的 recovery snapshot 纳入索引（operation `restore`）；
  `removeSkill` 在删除前备份 library 副本（`runtime`）+ deleteFiles 时备份仓库目录（`repo-dir`）
- **CLI `skillbox rollback [id]`**：无参列出备份表 / `--json`，带 id 恢复并输出结果
- **Web API**：`GET /api/rollbacks`、`POST /api/rollbacks/:id/restore`（走 mutation 锁）
- 测试：`backup/service.test.ts` 7 例、restore rollback-able 1 例、remove 备份 1 例、CLI rollback 1 例、web rollback 1 例

仍缺（非阻断）：Web UI 的 rollback 入口（可在 Skill Detail 的 lifecycle 卡片补一个 Restore-backup 按钮）；
manifest/lockfile 快照级回滚（operation journal，roadmap 2.1 未做）。

### 3.4 配置模型仍与 SPEC 有差异（部分未变）

- `web` 配置仍只有 `port` / `open`，**缺 `web.host`**：CLI `web --host` flag 存在，但 config schema、
  Settings 页面与 API 都不支持 host
- Agent override 仍是单个 `path` / `executable`，SPEC 规划的 `skillDirectories: string[]` 只存在于
  domain 检测模型（`domain/agent.ts`），尚未进入 Runtime Config 覆盖
- 新增字段时应提供 schema migration 或向后兼容解析（与 §4.2 联动）

### 3.5 Logging 尚未贯穿主要业务流水线（未变）

Logger、verbosity、脱敏与 CLI flags 已落地。**CLI mutation 审计日志已接入**：`CliContext.logger`
（默认写 `~/.skillbox/logs/skillbox.log`）+ 13 个 mutation 命令 + connect/disconnect 记录
`mutation:<op>:start/done/failed`（含错误 message，经 redactor 脱敏）；debug bundle 的 log tail 现在有真实内容。
仍缺：core 业务层（install/reconcile/registry/lifecycle 事务内部）的结构化 debug 事件。

---

## 4. P1 — 可靠性与架构基础设施

### 4.1 ✅ `runtime.lock` 并发保护（2026-08-14）

`packages/core/src/operations/lock.ts`：跨进程 mutation 锁（`~/.skillbox/state/locks/<name>.lock`），
原子创建（O_EXCL）+ owner 元数据（pid/hostname/createdAt）+ stale 检测（默认 10min，自动破除并重试）+
安全释放（只删自己仍持有的锁）。CLI 全部 mutation 命令（create/remove/enable/disable/install/sync/pull/
add/update/fork/vendor/edit/merge）已用 `mutation(ctx, …)` 包裹（同一个 `mutation` 锁）。测试：
`operations/lock.test.ts` 5 例 + CLI 锁冲突测试。Interactive/Web 直连服务的路径待接入（Web 随 §3.2 一并接入）。

### 4.2 ✅ Schema Migration（2026-08-14）

`packages/core/src/migrations/`：`MigrationRegistry`（版本递增、幂等、`MIGRATION_MISSING`/
`MIGRATION_FAILED`）、`migrateVersionedDocument`（读版本、拒绝新版本、迁移到当前、schema 校验）、
按文档注册表：manifest / lockfile（v1 为首版，注册表为空，更旧版明确报 `MIGRATION_MISSING`）、
config（真实 v0→v1：为无版本字段的旧 config 盖上 `version: 1`）。
`migrateRepository` 落盘迁移；`readManifest` / `readLockfile` 读旧版本时内存自动迁移；
runtime config schema 新增可选 `version` 字段。CLI 新增 `skillbox migrate` 命令。
测试：`migrations/index.test.ts` 12 例 + CLI migrate 测试。

### 4.3 ✅ 统一 Backup 机制（2026-08-14）

`BackupService`（§3.3）统一了备份/保留/清理/恢复策略：索引 + 独立副本 + retention（每 operation+alias
默认保留 10）+ `skillbox rollback` 恢复。已覆盖：Managed Restore 的 recovery snapshot、remove 的
runtime/repo-dir 备份；merge 的 pre-merge backup（`merge/state.ts`）保持独立（与 merge state 强耦合）。
仍缺：destructive migration 的备份（当前无 destructive 迁移，migration registry 为空）。

### 4.4 Event Bus / Progress Model

无进程内 Event Bus；无 Download progress、Install lifecycle events、Git sync events、
Security finding events、Web/TUI 实时进度订阅。

### 4.5 ✅ Doctor 与 Debug Bundle（2026-08-14）

`packages/core/src/diagnostics/`（roadmap 5.3）+ CLI `skillbox doctor`：

- **probes**（`runDoctorProbes`，永不抛错，逐项报错）：git 二进制与版本、node、platform、home 可写、
  config、manifest、lockfile、manifest⇄lockfile 一致性、agents 检测、library 物化数、links 状态、
  credential store（set/get/delete 探针）
- **debug bundle**（`createDebugBundle`）：doctor 报告 + 脱敏 config（scrubText）+ 日志尾部（逐行脱敏）+
  仓库摘要（manifest/lockfile present/missing/invalid + skills 列表）+ **自动泄漏扫描**
  （`scanForLeaks`：github token `ghp_` 等前缀、Authorization/Bearer 头、x-oauth-token/x-github-token；
  命中只报 pattern+source+count，绝不包含值）
- **CLI**：`skillbox doctor`（人类可读 / `--json` / `--bundle <path>`，泄漏命中时输出 WARNING；
  探针失败时**退出码非零**，CI 可用 `skillbox doctor` 做门禁）
- 测试：`diagnostics/doctor.test.ts` 4 例 + CLI doctor 1 例

---

## 5. P2 — Agent、交互与分发扩展

- ✅ 全部六个 adapter 已实现：Claude / Codex / Cursor / **Gemini CLI** / **OpenCode** / **Windsurf** /
  **GitHub Copilot**（2026-08-14；每个都通过共享 `runCliAdapterSuite` 一致性套件，已注册进
  `createDefaultAgentRegistry`）
- Fullscreen TUI 未实现，但 MVP_TASKS 允许 V0.1 不做，非阻断
- 独立 `packages/web-server` 未拆分（Hono server 仍在 CLI package），按需再拆

---

## 6. 发布与验收缺口

### 6.1 npm 发布配置（部分落地）

- ✅ cli / core / shared / root 已补齐 `license`（MIT）/ `repository` / `homepage` / `bugs` metadata；
  root 新增 `pnpm pack:verify`（`scripts/verify-package.mjs`：`npm pack --dry-run` 断言 bin/dist/
  dist/web 完整，并报告 private/workspace 两个发布 blocker）
- 仍为决策项（脚本如实报告，不阻断）：`"private": true` 未移除、`workspace:*` 依赖需按
  shared → core → cli 顺序发布、`OWNER/REPO` 占位待仓库公开后替换、provenance 发布配置

### 6.2 README / Release Metadata（部分修复）

- README CI badge 仍为 `OWNER/REPO` 占位（仓库公开前无法替换）
- ✅ README Roadmap 已更新：0.2/0.3 标记已落地、0.4 部分落地、E2E 状态、Git 运行时依赖；
  `INSTALLATION.md` 系统要求同步
- 发布 metadata（repository/homepage/bugs/license/provenance）待 §6.1 一并补齐

### 6.3 E2E 验收与自动化（部分落地）

- ✅ `packages/testing` CLI 子进程 harness + git-free 旅程已通过（§2.3），CI build 后跑 `pnpm test:e2e`
- ✅ **git 旅程已编写**（`e2e-git.test.ts`：bare remote fixture + create→commit→push→clone→pull，
  自跳过当 git 缺失/CLI 未构建；本机无 git 所以 2 例跳过，CI 上会执行）
- `docs/e2e-acceptance.md` 仍是纯手工手册，未记录完成结果；authorization timeout/cancel/retry、
  private remote auth failure、三平台 manual acceptance 仍缺（roadmap 阶段 3 未勾选项）

---

## 7. 文档与代码债务

### 7.1 过时注释（已清理一部分，仍有残留）

- ✅ 已清理：`skill-lifecycle/service.ts` 的「`detectManagedModifications` has not landed」、
  `skill-lifecycle/types.ts` / `loaders.ts` 的 `restoreManagedSkill` TODO（Restore 已实现）、
  `sync/loaders.ts` 的旧 GitHub 构造器注释
- 仍准确：`exit-codes.ts`「until agent 2 lands `MERGE_CONFLICT`」（Core `ErrorCode` 确无
  `MERGE_CONFLICT`，有 `MERGE_BINARY_CONFLICT` 等）、`marketplace/service.ts` 的 git/registry
  source TODO（§3.1）、`install/transaction.ts` 的 provider TODO（§3.1 的不一致）

### 7.2 重复 Adapter、动态导入与双 Orchestrator（部分缓解）

- ✅ pull/push orchestration 已统一：`SyncService` 经 `SyncGitTransport` 走 Core `RepositorySync`
  （Credential Bridge），不再自行实现 git pull/push
- 残留：CLI Sync / Marketplace / Lifecycle 仍大量使用 `loadSkillboxCore()` 动态导入 +
  `Record<string, unknown>` 结构转换 + runtime arity check；`SyncService.connect/disconnect` 保留为
  legacy fallback（生产默认路径已走 RepositorySync）
- 建议：各模块稳定后改为显式 typed factory、删除宽泛转换、保留 DI seam 供测试

---

## 8. 明确非近期范围（未变）

- 自建中心化 Registry、SaaS 云盘 / Remote Dashboard、Team / Billing / RBAC / Cloud Database、
  强制桌面客户端、新 Skill 标准、MCP / Rules / Prompts / Hooks 统一管理、AI 自动生成 Skill、
  Plugin marketplace

---

## 9. 本次验证基线（2026-08-14，master `03a48f59`）

### 9.1 执行结果

| 命令                             | 结果                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile` | 首次失败（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`），`CI=true` 后成功；**原 node_modules 不完整**（缺 `@rollup/rollup-linux-x64-gnu` 原生可选依赖，vitest/vite 无法启动） |
| `pnpm typecheck`                 | ✅ 通过                                                                                                                                                                        |
| `pnpm lint`                      | ESLint ✅；Prettier 首次失败——`pnpm install` 在工作区生成了 171MB `.pnpm-store/`，未被 `.prettierignore` 排除；**已修复**（见 §9.3）                                           |
| `pnpm test`                      | 见 9.2                                                                                                                                                                         |
| `pnpm build`                     | ✅ 通过（tsc -b + vite build + 前端资源复制进 `packages/cli/dist/web`）                                                                                                        |

### 9.2 测试明细（最新：全绿基线 2026-08-14）

> 本机已安装 git（2.47.3），**全部测试套件通过，无环境性失败**。

- `packages/core`：**734/734 通过（71 文件）**——含此前因缺 git 而失败的
  `git-client`（18）、`reconcile/engine`（2）、`status-service`（2）、`repository-sync`（1）共 23 例
- `packages/cli`：**294/294 通过（18 文件）**——含生命周期 wiring（15s 超时配置后无偶发超时）
- `packages/testing`：**7/7 通过**——git-free 旅程 5 例 + **git 旅程 2 例**
  （bare remote fixture：create→commit→push→fresh-clone→pull→status）
- `packages/shared`：1/1 通过；`apps/web`：8/8 通过

### 9.3 本次修复的仓库卫生问题

- `.prettierignore` / `.gitignore` 增加 `.pnpm-store`（pnpm 本地 store 会随 install 落在工作区，
  导致 `pnpm lint` 失败且可能被误提交）

### 9.4 环境前置与文档不符（已修复）

- ✅ `INSTALLATION.md` 系统要求已把 Git 列为**运行时依赖**（`connect/sync/pull/push` 与 Reconcile 通过
  系统 git 执行，缺失报 `GIT_NOT_FOUND`）；README 一句话版已同步
- 本机未安装 git 二进制，core 的 24 个 git 依赖测试无法在此环境运行（CI ubuntu-latest 自带 git，可全绿）

### 9.5 本轮（2026-08-14 第二次审查）交付

- `restoreManagedSkill` Core transaction + CLI 接线 + 10 测试（§2.1）
- `createSyncGitTransport` 接通 RepositorySync / Credential Bridge + 8 测试（§2.2）
- `packages/testing` CLI harness + git-free E2E 旅程 + `pnpm test:e2e` + CI 步骤（§2.3）
- README Roadmap / INSTALLATION.md 同步现状（§6.2、§9.4）
- 过时注释清理（§7.1）、`.prettierignore`/`.gitignore` 补 `.pnpm-store`（§9.3）
- `packages/testing/vitest.config.ts`：E2E 套件 30s 超时（慢机 flaky 策略，§9.2）

### 9.6 本轮（2026-08-14 第三次审查，Wave 3.1）交付

- install 下载目录契约修复（provider 子树契约；path 穿越改下载前校验）；cache 标记移至条目旁文件
- 转换统一：install → `toManifestSource`、marketplace → `fromManifestSource`
- `git:` / scp-style source 支持：`NormalizedSource` 新增 `git` 类型、`parseSource` / `toManifest` /
  `fromManifest` round-trip、`GitSourceProvider`（ls-remote pin + 子树 materialize）注册进默认 provider、
  别名/描述/cache key/CLI 展示覆盖
- 测试：registry 88（+11 git/source 用例）、install 30（+git source 端到端）、CLI marketplace/sync 123 全通过
- 验证：typecheck / lint / build ✅；core 663 通过 / 23 失败（仍全部为本机缺 git 二进制）；e2e 5/5 ✅

### 9.7 本轮（2026-08-14 第四次审查，Wave 3.4）交付

- `operations/lock.ts`：跨进程 mutation 锁（O_EXCL + owner 元数据 + stale 破除 + 安全释放）；
  CLI 13 个 mutation 命令接入（`mutation(ctx, …)`）；`RUNTIME_LOCKED` 错误码
- `migrations/`：`MigrationRegistry` + `migrateVersionedDocument` + manifest/lockfile/config 注册表
  （config 真实 v0→v1）+ `migrateRepository` + `skillbox migrate` 命令 + readManifest/readLockfile
  内存自动迁移 + config `version` 字段；`MIGRATION_MISSING` / `MIGRATION_FAILED` 错误码
- 测试：`operations/lock.test.ts` 5 例、`migrations/index.test.ts` 12 例、CLI migrate + 锁冲突 2 例；
  marketplace/skill-lifecycle/sync 193 例全通过（锁接线无回归）
- 验证：typecheck / lint ✅；core/cli 全量见 §9.2（core 663/23 同前）

### 9.8 本轮（2026-08-14 第五次审查，Wave 3.2）交付

- Web lifecycle API：fork / vendor / restore / merge（含 continue/abort）4 个端点，全部 Core-backed
- Web mutation 锁接入全部 mutating 路由（create/content/delete/enable/disable/reconcile/install/
  settings + lifecycle）
- Web 错误映射补 lifecycle/merge/restore/lock 状态码（409/500）；web services 注册 `GitSourceProvider`
- 前端：api.ts 4 个 client 方法 + queries 2 个 hooks + SkillDetailPage Lifecycle 卡片
  （状态机动作、确认、结果/冲突渲染）
- 测试：web/app.test.ts +5（真实 Core fork/vendor/restore、merge 路由、错误信封）→ 41/41；
  CLI 全量 291/291 ✅；e2e 5/5 ✅；typecheck / lint / build ✅

### 9.9 本轮（2026-08-14 第六次审查，Wave 3.3）交付

- `backup/`：`BackupService`（索引 `state/backups/index.json` + 独立副本 + retention 保留策略 +
  record/list/get/forget/rollback/prune）；kind `runtime` | `repo-dir`；
  错误码 `BACKUP_NOT_FOUND` / `BACKUP_INCOMPLETE` / `BACKUP_REPOSITORY_MISMATCH` / `ROLLBACK_FAILED`
- 接线：`restoreManagedSkill` 的 recovery snapshot 入索引（可 rollback 撤销 restore）；
  `removeSkill` 删除前备份 library + repo-dir（deleteFiles 时）
- CLI `skillbox rollback [id]`（列表/JSON/恢复）；Web `GET /api/rollbacks` +
  `POST /api/rollbacks/:id/restore`（mutation 锁）
- 测试：backup 7 例、restore rollback-able 1 例、remove 备份 1 例、CLI rollback 1 例、web rollback 1 例
- 验证：core 689 通过 / 23 失败（git 二进制环境问题）；CLI 293/293 ✅；e2e 5/5 ✅；typecheck/lint/build ✅

### 9.10 本轮（2026-08-14 第七次审查，Wave 3.1 残余 + Wave 2 git 旅程 + 发布 metadata）交付

- Reconcile registry（skills.sh）source 回退 provider：`ReconcileOptions.registry` + `resolveRegistrySource`
  （resolve → download 子树 → materialize），fresh clone 可物化 registry 技能；无 provider 时可操作提示；
  SkillService 注入 `defaultRegistry`；reconcile +2 测试
- `gitlab:` / `bitbucket:` scheme 简写 → git URL（`ssh:` / `file:` 仍拒绝）；source 测试 +1
- git 旅程 E2E：`packages/testing/src/git-fixture.ts`（bare remote fixture + runGit + isGitAvailable）+
  `e2e-git.test.ts`（create→commit→push→clone→pull，git 缺失/CLI 未构建时自跳过，CI 执行）
- npm 发布 metadata：cli/core/shared/root 补 `license`/`repository`/`homepage`/`bugs`；root 新增
  `pnpm pack:verify`（`npm pack --dry-run` 断言 CLI 包内容，报告 private/workspace blocker）
- 验证：core typecheck ✅、registry/source + reconcile 测试通过；testing 5 通过 / 2 跳过（git 缺失）

### 9.11 本轮（2026-08-14 第八次审查，Wave 4：doctor + Gemini adapter）交付

- `diagnostics/`：`runDoctorProbes`（12 项 probe）、`createDebugBundle`（脱敏 config + 日志尾 +
  仓库摘要 + `scanForLeaks` 自动泄漏扫描）、CLI `skillbox doctor`（`--json` / `--bundle`）；
  测试 +5
- Gemini CLI adapter（`adapters/gemini.ts`，共享 conformance suite 14 例）注册进默认 registry；
  `registry.test.ts` 期望更新
- 验证：core 710 通过 / 23 失败（git 二进制环境问题）；CLI 294/294 ✅；e2e 5 通过 / 2 跳过；
  typecheck / lint / build ✅

### 9.13 本轮（git 就绪后第二批）交付

- **OpenCode / Windsurf / GitHub Copilot adapters**：三个新 adapter 走同一 `CliAgentAdapter` 模板
  （`.config/opencode/skills` / `.windsurf/skills` / `.copilot/skills` + 各自 BIN/CONFIG_DIR 环境变量），
  通过共享 conformance suite；默认 registry 现注册全部 6 个 adapter
- **doctor 退出码**：`skillbox doctor` 探针失败时抛 `SKILL_BROKEN`（退出 1），`--json` 同样生效
- **logging 贯穿（CLI 层）**：`CliContext.logger` 默认写 `~/.skillbox/logs/skillbox.log`；13 个 mutation
  命令 + connect/disconnect 记录 `mutation:<op>:start/done/failed` 审计日志（debug bundle 的 log tail
  因此有真实内容）；测试 +1
- 验证：core 776/776、CLI 295/295、e2e 7/7、typecheck / lint / build ✅

### 9.12 本轮（git 就绪后）交付

- 本机安装 git（2.47.3）→ **全量测试全绿**：core 734/734、CLI 294/294、e2e 7/7（含 2 例 git 旅程）
- **修复真实 bug**（git 旅程暴露）：无可用 Secret Service 的机器（headless Linux / WSL）上
  `RepositorySync.pull` 因 `CREDENTIAL_STORE_UNAVAILABLE` 直接失败——`TokenStore.read()` 现在把
  store 不可用视为 `not-connected`（无 token），`getGitTransportAuth` 走 `GITHUB_NOT_CONNECTED`
  回退路径（公开 remote 用普通 git 传输继续可用）；token-store 测试 +1
- `skillbox doctor` 实测：12 项探针正常输出，headless 机器上 credentials 探针如实报
  "Linux Secret Service unavailable"（该机器 connect 需可用 keychain，属环境限制，非代码缺陷）

---

## 10. 建议实施顺序（状态更新：Wave 1 已完成）

### Wave 1 — 恢复真实主流程 ✅ 已完成（2026-08-14）

1. ✅ `restoreManagedSkill` Core transaction（§2.1）
2. ✅ CLI sync/pull/push 迁入 RepositorySync / Credential Bridge（§2.2）
3. ✅ pull/push orchestration 去重（SyncGitTransport，§7.2）
4. ✅ Hermetic CLI E2E harness + git-free 旅程（§2.3）

### Wave 2 — 建立可信验收

1. ✅ git 旅程 E2E（bare remote fixture，CI 执行）；authorization timeout/cancel/retry、
   private remote auth failure 待补
2. 三平台 manual acceptance 记录；`docs/e2e-acceptance.md` 改为带证据的结果记录
3. ✅ 更新 README Roadmap / INSTALLATION.md 与现状一致（§6.2、§9.4）
4. ✅ flaky 超时策略：core/cli/testing 均配置 15–60s vitest 超时（roadmap 3.3；§9.2）

### Wave 3 — 产品能力闭环 ✅ 全部完成

1. ✅ 统一 Marketplace / Manifest Source 模型（§3.1：git source、install 契约、转换统一；残余：Reconcile registry 回退、gitlab:/bitbucket: 简写）
2. ✅ Web Fork/Vendor/Edit/Restore/Merge（§3.2：API + UI + mutation 锁）
3. ✅ 通用 Backup / Rollback（§3.3、§4.3：BackupService + `skillbox rollback` + Web API）
4. ✅ runtime lock 与 schema migration（§4.1、§4.2）

### Wave 4 — 发布与扩展

1. npm pack / publish 配置（§6.1）
2. doctor / debug bundle / Event Bus / logging 贯穿（§3.5、§4.4、§4.5）
3. Gemini / OpenCode 等 Agent adapters（§5）
4. 视需求拆分 Web Server 或实现 Fullscreen TUI（§5）
