# Skillbox P1/P2 完整实施设计

**日期：** 2026-08-13

**状态：** 已批准，待用户审阅书面规格

## 1. 目标与范围

完成当前 `GAP_ANALYSIS.md` 中全部 P1 与 P2 优化项，并将原本条件性的
Fullscreen TUI 和独立 `web-server` package 纳入必做范围。交付目标是可发布的
Skillbox：所有入口共享同一 Core 业务规则，写操作可恢复，来源行为一致，自动与
平台验收均有可追溯证据。

本设计不包含非近期范围中的 SaaS、中心化 Registry、团队/计费、AI 生成 Skill 或
Plugin marketplace。

## 2. 核心边界

### 2.1 OperationRuntime

`OperationRuntime` 是全部写操作的唯一运行时边界，负责：

- 跨进程 repository lock、owner metadata 与 stale-lock recovery；
- operation journal、阶段进度事件与崩溃恢复；
- snapshot、backup index、保留和清理策略；
- 基于记录的用户级 rollback；
- 结构化、脱敏的诊断事件。

Install、sync、add、update、fork、vendor、restore、merge、remove、migration 均先通过
该边界，再暴露给 CLI、Web、TUI 或 web-server。失败必须返回明确的 recoverable outcome；
不完整 journal 禁止不安全的后续 mutation，直至恢复或显式放弃。

### 2.2 SkillSourceResolver

`SkillSourceResolver` 为 GitHub、Git、Registry、Local 提供 canonical Source union，以及
统一的 parse、serialize、resolve、download、latest、materialize 和 capability/error 合约。

Install、Reconcile、Marketplace、Diff、Merge、Restore、Web 与 TUI 都只依赖该接口。
它替换分散的 provider registry、重复 source mapping 和 runtime arity checks；不支持的
能力必须返回稳定、可操作的错误，不得静默降级。

### 2.3 入口与服务

CLI、Interactive CLI、Web、Fullscreen TUI 和独立 web-server 都是 Core service 的薄层：

- CLI/TUI 负责命令、确认、进度渲染与退出码；
- web-server 提供可独立部署、版本化的 API；
- Web UI 只消费该 API，并渲染统一的 result/error/progress model；
- 各入口不得复制 lifecycle、source、rollback 或 secret-handling 规则。

## 3. 交付批次

### Batch 1 — OperationRuntime 与恢复基础

实现 lock、journal、snapshot、backup index、rollback records 和 fault injection seams。
迁移 Restore，并为 Fork、Vendor、Remove、Merge 规定接入顺序与原子/恢复语义。

验收：并发 mutation 不损坏 repository；任一已定义写阶段失败后恢复一致状态；过期、
不完整、跨 repository 的 rollback record 被拒绝。

### Batch 2 — Source 统一与生命周期闭环

实现 `SkillSourceResolver` 和四类 source adapters，迁移现有调用方。Restore 在 cache miss 时
重新 materialize 锁定 revision，并验证/恢复 Agent links；现有 GitHub-cache-only 限制移除。

验收：相同 source 在 Install、Update、Reconcile、Diff、Merge、Restore 和所有入口中具有
一致的结果与错误契约。

### Batch 3 — Hermetic E2E 与平台证据

新增临时 HOME/repository、打包 CLI 子进程、bare Git remote、受控 GitHub/Registry HTTP server
和跨平台 cleanup 的测试 harness。自动覆盖核心旅程，并在 Windows、macOS、Linux 记录凭据、
链接、Agent、browser/headless 的人工证据。

验收：平台无关 P0/P1 旅程进入 CI；flaky case 有隔离或重试策略；
`docs/e2e-acceptance.md` 记录实际结果而非待办。

### Batch 4 — Web、TUI 与独立服务

实现 Web 生命周期 API/UI（Fork、Vendor、Edit/Restore、Merge Continue/Abort、Rollback），
提供一致的风险确认和进度。提取独立 `web-server` package；Fullscreen TUI 复用 CLI service。

验收：CLI/Web/TUI mutation 结果等价；web-server 可独立启动；TUI 覆盖核心日常旅程。

### Batch 5 — 诊断、迁移与发布

实现 schema migration registry、`skillbox migrate`、Doctor、脱敏 debug bundle、event bus 与
业务日志。完善 npm 发布 metadata、pack/install smoke test、release automation dry run；增加
Agent conformance suite 并实现 Gemini CLI、OpenCode、Windsurf、GitHub Copilot adapters。

验收：迁移确定、幂等、可恢复；debug bundle 不含 secret；干净环境中的 packed CLI、Web assets
和 bin 可用；release dry run 与新 Agent conformance suite 均通过。

## 4. 依赖与并行规则

- Batch 1 是所有 mutation/UI 扩展的前置条件。
- Batch 2 在 Batch 1 的 runtime 合约稳定后实施；可与 Batch 3 的 harness 基础并行，但 E2E
  journey 在 source 迁移完成后接入。
- Batch 4 只能消费已稳定的 Core contracts，不修改其业务规则。
- Batch 5 的 migration/diagnostics 可在 Batch 1 后并行开发；最终发布门禁依赖前四批完成。
- 每批次独立 PR、独立验证和可回退；不创建横跨多个批次的大型提交。

## 5. 统一验证与发布门禁

每个批次至少运行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

影响发布内容时追加 `pnpm pack` 与干净临时环境安装 smoke test。发布前还必须满足：

- 全部自动 E2E 与安全脱敏回归通过；
- Windows、macOS、Linux 的当前人工验收已记录；
- README、安装文档、Roadmap、GAP 分析与真实行为一致；
- CI 在默认分支和 PR 分支都覆盖质量、构建、E2E 与 pack/install 门禁；
- 无 open journal、stale lock 或未恢复的 operation record。

## 6. 风险控制

- Source 和事务迁移采用 adapter-first、双路径测试、逐调用方切换；不在缺少回归覆盖时删除旧路径。
- Rollback 只作用于同一 repository、完整且未过期的记录；删除性操作必须有明确确认。
- 所有 Git transport、Doctor 与 debug bundle 测试 token、authorization header、remote credential
  均不得出现在 argv、环境转储、remote URL、日志或导出文件。
- 平台专属能力不以 Linux/Windows CI 替代真实平台验收；验收失败时阻止发布而非弱化结论。
