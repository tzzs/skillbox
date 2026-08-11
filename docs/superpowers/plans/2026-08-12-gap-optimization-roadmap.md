# Skillbox P0–P2 优化实施计划

> 日期：2026-08-12
>
> 设计依据：`docs/superpowers/specs/2026-08-12-gap-optimization-roadmap-design.md`
>
> 差距依据：`GAP_ANALYSIS.md`
>
> 执行策略：风险与依赖优先；每个行为改动遵循 Red → Green，一次只推进一个垂直切片。

## 1. 执行约束

- 阶段退出门禁未通过，不合并依赖该阶段的后续工作。
- 测试只跨已批准 seam：`RepositorySync`、`SkillSourceResolver`、`SkillLifecycle`、
  `OperationRuntime`。
- 默认 production factory 必须有 integration test；fake adapter 不能作为功能完成证据。
- 每个写操作必须验证无部分持久化、失败恢复和 secret 脱敏。
- 不将整条路线堆入一个提交或 PR；按下面的交付批次独立提交。

## 2. 阶段 0 — 建立可信基线

### 0.1 恢复并记录验证基线

涉及文件：

- `package.json`
- `pnpm-lock.yaml`
- `.github/workflows/ci.yml`
- 新增阶段验收记录时使用 `docs/`

任务：

- [x] `pnpm install --frozen-lockfile`
- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] 记录失败命令、错误类别、是否为当前改动引入
- [x] 确认工作区没有构建产物或无关文件进入 Git

完成标准：依赖缺失不再掩盖测试结果；所有现有失败均有明确归属。

### 0.2 GitHub production wiring tracer bullet

目标 seam：未来的 `RepositorySync` production factory；迁移前由当前默认 CLI context 作为外部
入口。

涉及文件：

- `packages/cli/src/sync/loaders.ts`
- `packages/cli/src/sync/loaders.test.ts`
- `packages/core/src/github/github-service.ts`
- `packages/core/src/github/index.ts`

Red：

- [x] 测试默认 factory 构建真实 Core `GitHubService`
- [x] 测试 `connectionState` 映射 `GitHubConnectionSnapshot.state`
- [x] 测试 Device Flow 字段与时间单位映射
- [x] 测试 disconnect 调用真实 Core 方法名

Green：

- [x] 增加强类型 production factory
- [x] 注入 GitHubApi、CredentialStore、TokenStore、GitHubConfigStore
- [x] 从明确配置读取 Client ID；缺失时返回稳定可恢复错误
- [x] 删除旧构造器和旧方法名猜测

完成标准：默认 CLI provider 不依赖 fake 即可查询连接状态，测试对旧接线保持敏感。

### 0.3 Git remote status tracer bullet

目标 seam：`RepositorySync.status()`；迁移前由 `GitProvider.status()` 承载。

涉及文件：

- `packages/core/src/git/git-client.ts`
- `packages/core/src/git/git-client.test.ts`
- `packages/cli/src/sync/loaders.ts`
- `packages/cli/src/sync/pipeline.test.ts`

Red：

- [x] local bare remote fixture 返回真实 origin URL
- [x] upstream 分支返回真实 ahead/behind
- [x] 无 remote 与 detached HEAD 返回明确状态
- [x] pull/push 不再因 adapter 丢失 remote 而误报

Green：

- [x] GitClient 增加 remote/upstream introspection
- [x] 计算 `HEAD...@{upstream}` ahead/behind
- [x] GitClientAdapter 完整映射 status

完成标准：真实 local Git repository 的状态与 Git 命令结果一致。

### 0.4 Marketplace Update production wiring

只读审计发现默认 `skillbox update` 不会先注册 Core provider：`RegistryClientAdapter` 仅在自身被
调用时注册 provider，而 update 直接进入 `InstallServiceAdapter`，导致独立进程中的
`defaultRegistry` 为空。

Red：

- [x] 使用默认 production wiring 与 Local provider 执行 update
- [x] 证明测试不依赖预先调用 search/outdated 的副作用

Green：

- [x] production adapter 加载时统一注册默认 provider
- [x] update 与 add 使用同一 Core defaultRegistry
- [x] 保留重复注册幂等性

完成标准：全新进程可直接执行默认 `skillbox update`，不依赖其他命令预热 registry。

### 阶段 0 退出门禁

- [x] 全量质量命令通过，或现有失败已形成独立修复任务
- [x] 两个 production wiring 缺陷均有先失败、后通过的测试
- [x] 过时注释不再描述已不存在的接口事实

## 3. 阶段 1 — 打通 GitHub/Git 主流程

### 1.1 建立 RepositorySync module

涉及文件建议：

- `packages/core/src/sync/repository-sync.ts`
- `packages/core/src/sync/types.ts`
- `packages/core/src/sync/factory.ts`
- `packages/core/src/sync/index.ts`
- `packages/cli/src/program.ts`
- `packages/cli/src/interactive/session.ts`

任务：

- [ ] 定义 `status/connect/disconnect/sync/pull/push` interface
- [ ] 将现有 SyncService 行为迁入 module implementation
- [ ] CLI 与 Interactive CLI 只依赖该 interface
- [ ] 保留窄范围 adapter 注入供测试
- [ ] 删除重复 Git/GitHub orchestration

### 1.2 Connect repository orchestration

- [ ] Device Flow 完成后获取当前用户
- [x] denied/expired/failed 立即返回稳定 terminal outcome
- [x] slow-down 更新后续 polling interval
- [ ] 创建或选择默认 private repository
- [ ] 非 Git 目录按明确策略初始化
- [ ] 无 origin 时添加 origin
- [ ] origin 相同时幂等成功
- [ ] origin 不同时拒绝覆盖并给出显式选择
- [ ] 只在所有步骤完成后写 connected repository metadata

### 1.3 Private Git transport

- [ ] Credential Bridge 为 fetch/pull/push 提供临时凭据
- [ ] token 不进入 argv、environment dump、remote URL、日志
- [x] commit 在限定 managed paths 上显式执行 add，包含首次出现的 untracked 文件
- [x] 首次 push 使用 `--set-upstream origin <branch>`
- [ ] push 失败保留本地 commit 并标记 recoverable
- [ ] disconnect 不修改 remote repository 或本地 Skill

### 1.4 阶段 1 integration journeys

- [ ] `connect → repository bind → sync → push`
- [ ] `clone → connect/install → pull`
- [ ] already-connected 幂等路径
- [ ] authorization timeout/cancel/retry
- [ ] private remote authentication failure

### 阶段 1 退出门禁

- [ ] 默认 production wiring 通过 integration test
- [ ] CLI help、README 与真实行为一致
- [ ] GitHub token 泄漏回归测试通过

## 4. 阶段 2 — Lifecycle 事务化

### 2.1 公共事务 primitives

涉及文件建议：

- `packages/core/src/operations/transaction.ts`
- `packages/core/src/operations/snapshot.ts`
- `packages/core/src/operations/journal.ts`
- `packages/core/src/lifecycle/restore.ts`

任务：

- [ ] 定义操作描述、快照、提交、回滚结果
- [ ] 快照覆盖文件、Manifest、Lockfile、config、Agent links
- [ ] 支持逐阶段 fault injection
- [ ] rollback 幂等

### 2.2 Managed Restore

- [ ] 验证目标为 Managed 且存在 pinned upstream
- [ ] Restore 前创建 recovery snapshot
- [ ] 重新下载 pinned revision
- [ ] 验证 structure 与 integrity
- [ ] 原子替换 library 内容
- [ ] 恢复 Agent links
- [ ] 清除 modified 状态
- [ ] 接入 `skillbox edit` Restore 分支

### 2.3 迁移现有 Lifecycle 写操作

- [ ] Vendor 使用公共事务
- [ ] Remove modified skill 使用公共事务与确认
- [ ] Merge 复用 snapshot/index，保持 continue/abort 语义
- [ ] Fork 的 Manifest/Lockfile/link 写入使用公共事务

### 2.4 用户级 Rollback

- [ ] 定义可回滚 operation 类型
- [ ] 定义 backup index 与保留策略
- [ ] 实现 `skillbox rollback [operation]`
- [ ] 拒绝过期、不完整、跨 repository record
- [ ] 输出恢复结果与后置状态

### 阶段 2 退出门禁

- [ ] Convert to Fork / Restore Upstream 均可用
- [ ] 每个写阶段 fault injection 后状态完全恢复
- [ ] backup/rollback 不跨越 repository seam

## 5. 阶段 3 — 建立端到端验收

### 3.1 Hermetic CLI E2E harness

涉及文件建议：

- `packages/testing/src/cli-harness.ts`
- `packages/testing/src/git-fixture.ts`
- `packages/testing/src/http-fixture.ts`
- `tests/e2e/`

任务：

- [ ] 临时 HOME、SKILLBOX_HOME、repository
- [ ] packaged CLI subprocess runner
- [ ] bare Git remote fixture
- [ ] controlled GitHub/Registry HTTP server
- [ ] 跨平台路径与清理重试

### 3.2 自动化旅程

- [ ] create/import/install/status
- [ ] connect/sync/pull/push
- [ ] search/add/outdated/update
- [ ] edit/fork/restore/diff/merge/continue/abort/rollback
- [ ] secret scan block/ignore/allow
- [ ] frozen lockfile/CI failure

### 3.3 平台验收

- [ ] Windows：DPAPI、junction/symlink/copy、Agent detect、browser
- [ ] macOS：Keychain、symlink/copy、Agent detect、browser
- [ ] Linux：Secret Service、symlink/copy、Agent detect、headless mode
- [ ] 更新 `docs/e2e-acceptance.md` 为带证据的结果记录

### 阶段 3 退出门禁

- [ ] 平台无关 P0 旅程进入 CI
- [ ] 平台特有行为拥有当前人工证据
- [ ] flaky test 有明确隔离与重试策略，不允许静默忽略

## 6. 阶段 4 — 统一 Source 与入口能力

### 4.1 SkillSourceResolver

涉及文件建议：

- `packages/core/src/source/types.ts`
- `packages/core/src/source/resolver.ts`
- `packages/core/src/source/providers/`

任务：

- [ ] 定义 canonical Source union
- [ ] 统一 parse/serialize/fromManifest/toManifest
- [ ] 统一 resolve/download/latest/materialize
- [ ] GitHub、Git、Registry、Local adapter
- [ ] provider capability 与稳定错误语义

### 4.2 调用方迁移

- [ ] Install
- [ ] Reconcile
- [ ] Marketplace search/add/outdated/update
- [ ] Diff
- [ ] Merge
- [ ] Restore
- [ ] Web services
- [ ] 删除重复 provider registry 与动态映射

### 4.3 Web Lifecycle parity

- [ ] Fork API/UI
- [ ] Vendor API/UI
- [ ] Edit/Restore API/UI
- [ ] Merge/Continue/Abort API/UI
- [ ] Rollback API/UI
- [ ] 共用 Core result/error rendering

### 阶段 4 退出门禁

- [ ] 同一 Source 在所有入口行为一致
- [ ] CLI/Web mutation 结果等价
- [ ] 不支持 Source 使用统一错误契约

## 7. 阶段 5 — 可靠性与诊断

### 5.1 OperationRuntime

涉及文件建议：

- `packages/core/src/operations/runtime.ts`
- `packages/core/src/operations/lock.ts`
- `packages/core/src/operations/events.ts`
- `packages/core/src/diagnostics/`
- `packages/core/src/migrations/`

任务：

- [ ] 跨进程 runtime lock
- [ ] owner metadata 与 stale lock recovery
- [ ] operation journal/crash recovery
- [ ] 进程内 Event Bus 与 progress event
- [ ] 业务日志接入 verbosity

### 5.2 Schema Migration

- [ ] Manifest migration registry
- [ ] Lockfile migration registry
- [ ] Runtime Config migration/兼容读取
- [ ] `skillbox migrate`
- [ ] 旧版 fixtures、幂等、失败恢复

### 5.3 Doctor 与 Debug Bundle

- [ ] Git/Node/Agent/link capability probes
- [ ] Credential Store 可用性 probe
- [ ] Manifest/Lockfile/library/link consistency checks
- [ ] `skillbox doctor` human/JSON output
- [ ] 脱敏 Debug Bundle
- [ ] secret/token/authorization header 泄漏测试

### 阶段 5 退出门禁

- [ ] 并发 mutation 无状态损坏
- [ ] 迁移确定性、幂等、可恢复
- [ ] Doctor 可定位计划内故障类别
- [ ] Debug Bundle 无 secret

## 8. 阶段 6 — 发布与 P2 扩展

### 6.1 npm 发布准备

- [ ] 确定 package 名称与所有权
- [ ] 仅开放应发布 package
- [ ] 完整 repository/homepage/bugs/license/provenance metadata
- [ ] 验证 workspace dependency 发布重写
- [ ] 验证 bundled Web assets 与 CLI bin
- [ ] clean temp install smoke test
- [ ] release dry run

### 6.2 文档与 CI

- [ ] 替换 README `OWNER/REPO`
- [ ] 同步 Roadmap、安装说明和当前限制
- [ ] CI 增加 pack/install smoke test
- [ ] 发布 checklist 与版本策略

### 6.3 Agent conformance suite

- [ ] 抽取共享 detect/scan/link/unlink suite
- [ ] capability/path override/copy fallback suite
- [ ] Gemini CLI adapter
- [ ] OpenCode adapter
- [ ] Windsurf adapter
- [ ] GitHub Copilot adapter

### 6.4 条件项

- [ ] 只有验证需求成立时实施 Fullscreen TUI
- [ ] 只有独立部署或复用需求成立时拆分 Web Server package

### 阶段 6 退出门禁

- [ ] packed CLI 在干净环境可用
- [ ] release automation dry run 通过
- [ ] 新 Agent adapter 全部通过 conformance suite

## 9. 每批次通用验证

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

影响 package 内容或进入发布阶段时追加：

```text
pnpm pack
```

每批次交付记录必须包含：

- 变更范围
- Red 测试及其失败原因
- Green 实现
- 完整验证结果
- 未自动验证的外部/平台门禁
- 下一批次入口条件
