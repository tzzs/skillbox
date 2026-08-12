# Skillbox P0–P2 优化路线设计

> 状态：已批准设计
>
> 日期：2026-08-12
>
> 代码基线：`375411d`；新版差距分析提交：`02df942`
>
> 输入文档：`GAP_ANALYSIS.md`

## 1. 目的

本设计将当前 P0–P2 差距清单转化为一条风险优先的优化路线。路线首先恢复真实的 GitHub/Git
用户主流程并建立可信的端到端验证，然后统一 Source 与 Lifecycle 行为，最后补齐可靠性、发布
能力和 Agent 扩展。

路线覆盖当前全部 P0–P2 缺口，但不会给予所有缺口相同优先级。工作顺序由用户影响、依赖方向，
以及继续在不稳定生产接线上开发的返工成本决定。

## 2. 设计原则

1. 生产接线是一级测试面。只有注入 fake adapter 时可用的 module 不算完成。
2. CLI、Interactive CLI 和 Web 使用相同的 Core interface，并接收一致的错误语义。
3. GitHub、Git、Source 解析、Lifecycle 事务和 Operation Runtime 应成为深 module，调用方不得复制
   其实现细节。
4. 每次持久化写入都必须加锁、可恢复，并在完成后验证后置条件。
5. 每个阶段都必须定义进入条件、交付物、验证方式和明确的退出门禁。
6. 文档与验收证据必须和它们描述的行为同时交付。
7. 条件性架构工作只有在真实用例出现时才实施，不能阻塞稳定版本发布。

## 3. 路线结构

路线分为七个有序阶段：

| 阶段 | 名称 | 主要成果 |
| --- | --- | --- |
| 0 | 建立可信基线 | 当前生产接线与验证失败均可见、可复现 |
| 1 | 打通 GitHub/Git 主流程 | Connect、绑定、Sync、Push、Clone、Install、Pull 经真实 adapter 可用 |
| 2 | Lifecycle 事务化 | Managed Restore 与统一备份、回滚语义完成 |
| 3 | 建立端到端验收 | 主要用户旅程成为可重复执行的发布门禁 |
| 4 | 统一 Source 与入口能力 | Source 行为一致，Web 达到 CLI Lifecycle 能力对等 |
| 5 | 可靠性与诊断 | 锁、迁移、事件、Doctor、Debug Bundle 保护所有操作 |
| 6 | 发布与 P2 扩展 | Package 可发布，额外 Agent 可安全接入 |

阶段退出门禁必须按顺序通过。只有在不修改同一 interface 或持久状态模型时，同一阶段内的任务
才允许并行推进。

## 4. 目标 module 与 seam

### 4.1 RepositorySync module

`RepositorySync` 用一个小 interface 承载完整的仓库传输旅程：

```ts
interface RepositorySync {
  status(): Promise<RepositorySyncStatus>
  connect(options?: ConnectOptions): Promise<ConnectResult>
  disconnect(): Promise<DisconnectResult>
  sync(): Promise<SyncResult>
  pull(): Promise<PullResult>
  push(): Promise<PushResult>
}
```

其 implementation 隐藏以下复杂性：

- GitHub Device Flow
- GitHub API 与 Client ID 配置
- Credential Store 与 TokenStore 构建
- 私有仓库创建或选择
- 本地 Git 初始化与 origin 绑定
- remote 与 ahead/behind 检查
- Git transport 临时凭据注入
- commit/pull/push 执行顺序
- 脱敏错误转换

CLI、Interactive CLI 及未来的 Web 同步路由只调用这个 interface，不再各自构建 GitHub 或 Git
依赖。

### 4.2 SkillSourceResolver module

`SkillSourceResolver` 向所有调用方提供统一 Source 模型：

```text
github / git / registry / local
```

其 interface 覆盖解析、标准化、provider 选择、revision 解析、下载、最新 revision 查询与
materialize。Marketplace、Install、Reconcile、Diff、Merge、Restore、Outdated 都使用同一个
interface。

provider 特有知识留在 adapter 内部。调用方不得根据 provider id 自行重建 URL、revision 或 cache
路径。

### 4.3 SkillLifecycle module

`SkillLifecycle` 负责所有模式转换或内容替换操作：

```ts
interface SkillLifecycle {
  fork(input: ForkInput): Promise<ForkResult>
  vendor(input: VendorInput): Promise<VendorResult>
  restore(input: RestoreInput): Promise<RestoreResult>
  merge(input: MergeInput): Promise<MergeResult>
  continueMerge(input: ContinueMergeInput): Promise<ContinueMergeResult>
  abortMerge(input: AbortMergeInput): Promise<AbortMergeResult>
  rollback(input: RollbackInput): Promise<RollbackResult>
}
```

其 implementation 统一管理 bases、merge state、backup、Manifest/Lockfile 原子更新、library
materialize、Agent link reconcile 和后置条件检查。调用方只接收稳定的 result object 与恢复错误，
不再自行编排内部文件路径。

### 4.4 OperationRuntime module

`OperationRuntime` 为所有写操作 module 提供共享保证：

```ts
interface OperationRuntime {
  runExclusive<T>(operation: OperationDescriptor, run: () => Promise<T>): Promise<T>
  emitProgress(event: OperationEvent): void
  diagnose(options?: DiagnoseOptions): Promise<DiagnosisReport>
  createDebugBundle(options?: DebugBundleOptions): Promise<DebugBundleResult>
  migrate(options?: MigrationOptions): Promise<MigrationResult>
}
```

其 implementation 管理 runtime lock、operation journal、进度事件、结构化脱敏日志、诊断探针、
Debug Bundle 生成与 schema migration registry。

事件机制先采用进程内实现。只有 Web 或 TUI 出现明确的跨进程或网络订阅需求时，才增加相应
transport。

## 5. 生产 factory 策略

每个外部 seam 都提供显式、强类型的 production factory 和测试 adapter：

- `createRepositorySync()`
- `createSkillSourceResolver()`
- `createSkillLifecycle()`
- `createOperationRuntime()`

factory 接收 repository root、Skillbox home、机器环境与窄范围平台依赖，返回对应的公开 module
interface。

迁移后，生产路径不再依赖：

- `Record<string, unknown>` module map
- 方法名猜测
- 函数参数数量检查
- loader 注释里已经过时的预期 interface

module seam 仍允许依赖注入。测试可以使用 memory 或 local adapter，但每个默认 production
factory 至少必须由一组 integration test 直接覆盖。

## 6. 写事务与恢复模型

所有持久化写入统一使用以下操作流：

```text
Validate
  → 获取 runtime lock
  → 解析依赖或 Source
  → 创建恢复快照
  → 应用文件系统变更
  → 原子更新 Manifest、Lockfile 或机器配置
  → Reconcile Agent links
  → 验证后置条件
  → 记录成功并发出结果
  → 释放 runtime lock
```

### 6.1 失败语义

- Validate 或 Resolve 失败不得产生持久化变更。
- 创建快照后的失败必须恢复文件、Manifest、Lockfile、机器配置和 Agent links。
- GitHub 授权失败不得创建 remote、修改 origin 或留下半连接配置。
- Git push 失败保留有效的本地 commit，并返回可重试结果；不得回滚 Skill 内容。
- Merge conflict 属于可恢复工作流状态，不属于事务失败。Merge state 必须保留以支持 continue 或
  abort。
- 进程崩溃后保留 journal record。下一次写命令必须阻止不安全继续，并引导用户自动恢复或运行
  `skillbox doctor`。
- 所有外部错误都必须包含稳定错误码、失败阶段、recoverable 标记、恢复建议和脱敏 context。

### 6.2 唯一事实来源

- Manifest：期望的 Skills 与 Agent assignments
- Lockfile：解析后的 revision、integrity、upstream 与 security metadata
- Machine Config：本机路径、Web 设置与非敏感 GitHub metadata
- Credential Store：唯一允许持久化 token 的位置
- Operation State：短期 lock、journal、merge state 与 backup index

任何入口层都不得从渲染结果或局部重复状态推断第二套事实来源。

## 7. 阶段设计

### 7.1 阶段 0 — 建立可信基线

进入条件：新版差距分析已接受。

交付物：

- 使用已提交 lockfile 恢复依赖
- 执行 lint、typecheck、test 与 build
- 在功能改动前分类所有现有失败
- 为当前 GitHub production factory 接口不匹配增加失败 integration test
- 增加测试证明 Git status 当前缺失真实 remote 与 ahead/behind 信息
- 只有在确认真实 interface 后才清理误导性的 “not landed” 注释
- 记录基线命令输出与平台环境

退出门禁：

- 所有既有失败均已修复，或明确记录所属阶段与处理责任
- 不依赖 fake provider 即可复现 production wiring 缺陷
- 不存在因依赖缺失而被隐藏的已知回归

### 7.2 阶段 1 — 打通 GitHub/Git 主流程

进入条件：阶段 0 退出门禁通过。

交付物：

- 实现强类型 GitHub production factory
- 正确映射 Core authorization state 与 Device Flow 时间单位
- 增加 Git remote URL、upstream branch、ahead、behind 检查
- 让 `status`、`pull`、`push` 使用真实 remote 状态
- 扩展 connect：创建或选择私有仓库
- 必要时初始化 Git，并安全绑定或验证 origin
- 将 Credential Bridge 注入私有仓库 Git transport，且 token 不落盘
- 保持 disconnect 语义：只删除本地凭据与连接 metadata
- 将 RepositorySync 接入 CLI 与 Interactive CLI
- 更新 help 与 README，使声明和真实能力一致

退出门禁：

```text
connect → repository bind → sync → push
clone → connect/install → pull
```

两条旅程均须通过默认 production wiring 的 integration test。只有 GitHub HTTP 请求可在 adapter
seam 替换为受控实现。

### 7.3 阶段 2 — Lifecycle 事务化

进入条件：远程 Source materialize 已可靠运行。

交付物：

- 实现 `restoreManagedSkill`
- 引入统一 snapshot 与 rollback primitives
- 在适用范围内为 Restore、Vendor、Remove、Merge 使用统一事务语义
- 定义面向用户的 rollback record 与保留策略
- 为已记录的 Lifecycle 操作实现首版 `skillbox rollback` interface
- 恢复后验证 integrity、Lockfile metadata、library materialize 与 Agent links
- 保持未解决 merge 的 continue/abort 语义

退出门禁：

- `skillbox edit` 的 Convert to Fork 与 Restore Upstream 均可用
- 在每个写入阶段注入失败后，都能恢复操作前状态
- rollback 不得作用于不完整、已过期或无关的 operation

### 7.4 阶段 3 — 建立端到端验收

进入条件：P0 用户旅程功能完整。

交付物：

- 使用临时 HOME 与 repository 的 hermetic CLI E2E harness
- 使用 local bare Git remote 验证 transport
- 受控 Registry 与 GitHub HTTP adapter
- 使用真实 CLI subprocess 覆盖 Local Management、Sync、Marketplace、Lifecycle
- Windows、macOS、Linux 人工验收模板
- 记录 Credential Store、link strategy、Agent detection 与浏览器启动结果
- CI 中分离快速 module test 与较慢的 E2E test

退出门禁：

- 所有平台无关 P0 旅程均成为自动化发布门禁
- 所有平台特有行为都有当前验收证据
- `docs/e2e-acceptance.md` 记录实际结果，而不再只是未勾选意图

### 7.5 阶段 4 — 统一 Source 与入口能力

进入条件：E2E harness 已能保护 Source 与 Lifecycle 改动。

交付物：

- 定义唯一 canonical source type 与序列化契约
- 为 add/install/outdated/update 增加 Git Source provider 支持
- 通过 provider dispatch 处理 Manifest Registry Source
- GitLab 与 Bitbucket 先通过 Git provider 支持，不提前增加独立一方 Registry 集成
- 删除 CLI 与 Web 重复的 provider 注册逻辑
- 让 Reconcile、Diff、Merge、Restore、Marketplace 统一使用 SkillSourceResolver
- 增加 Web Fork、Vendor、Edit、Restore、Merge、Continue、Abort、Rollback 路由与 UI
- 所有 mutation logic 继续留在 Core module

退出门禁：

- 同一种受支持 Source 在 CLI、Interactive CLI、Web 中行为一致
- 不支持的 Source 在 parse/resolve 阶段使用同一错误契约失败
- CLI 与 Web Lifecycle 操作产生等价的持久化结果

### 7.6 阶段 5 — 可靠性与诊断

进入条件：所有主要写流程已使用目标 module。

交付物：

- 实现支持 stale-lock recovery 的跨进程 `runtime.lock`
- 增加 operation journal 与 crash recovery
- 增加 Manifest、Lockfile、Runtime Config migration registry
- 提供 `skillbox migrate`
- 从 Sync、Install、Reconcile、Registry、Lifecycle 发出结构化进度事件
- 将 verbosity level 接入业务事件
- 实现 `skillbox doctor`
- 实现脱敏 Debug Bundle
- 验证 token、authorization header、含凭据 URL 不会进入日志或 bundle

退出门禁：

- 并发写测试无法破坏持久状态
- 旧版受支持 fixture 可确定性、幂等迁移
- Doctor 能识别故意注入的环境与一致性故障
- secret leak 回归测试通过

### 7.7 阶段 6 — 发布与 P2 扩展

进入条件：阶段 0–5 的发布门禁全部通过。

交付物：

- 确定公开 npm package 名称与所有权
- 只移除需要发布 package 的 `private`
- 增加 repository、homepage、bugs、license、provenance 与 publish metadata
- 使用 `pnpm pack` 验证 workspace dependency 重写与 bundled Web assets
- 在干净临时环境中安装 packed artifacts
- 替换 README repository 占位并同步 Roadmap 状态
- 逐个增加 Gemini CLI、OpenCode、Windsurf、GitHub Copilot adapter
- 复用 capability model、path override、detect、scan、link、unlink、copy fallback 测试套件

条件性交付物：

- 只有已验证工作流需要持续多面板交互时，才实现 Fullscreen TUI
- 只有出现独立部署或复用需求时，才拆分 standalone Web Server package

退出门禁：

- packed CLI 可在干净环境执行所有受支持本地命令
- 发布 metadata 完整，release automation 可完成 dry run
- 每个新 Agent adapter 均通过共享 adapter conformance suite

## 8. 验证策略

### 8.1 Module test

测试通过公开 module interface 验证成功路径、稳定错误码、rollback 和不变量。内部 adapter 只验证
平台或 provider 差异。

### 8.2 Integration test

Integration test 使用临时目录、真实文件系统、local Git repository、bare remote 与受控 HTTP
server。每个默认 production factory 均须被直接覆盖。

### 8.3 Hermetic CLI E2E

E2E harness 通过 subprocess 执行 packaged CLI，并覆盖：

```text
create/import/install/status
connect/sync/pull/push
search/add/outdated/update
edit/fork/restore/diff/merge/continue/abort/rollback
```

真实交互式 GitHub 授权不自动化。Device Flow 协议行为在 HTTP adapter seam 测试；repository
orchestration 与 Git transport 必须保持真实、本地、可控。

### 8.4 平台验收

Windows、macOS、Linux 验收记录必须包含日期、操作系统、Node/pnpm/Git 版本、Credential Store
结果、link strategy 结果、已检测 Agent、浏览器启动结果和证据位置。

### 8.5 通用质量门禁

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

进入发布工作后，`pnpm pack` 为强制门禁。此前阶段只有在改动影响 package 内容时才要求 scoped
pack smoke test。

## 9. 交付策略

- 每个阶段使用一个或多个聚焦分支与 PR；整条路线不得堆入一个大型变更。
- 只有临时兼容行为明确且有测试时，interface 才可先于调用方迁移落地；否则 interface 与调用方
  必须原子提交。
- 每项行为改动先在对应 seam 增加失败测试。
- 文档、错误信息与验收证据和对应行为在同一阶段交付。
- 阶段存在失败的阻断测试时不得退出。
- 后续阶段可以探索，但依赖未通过的前置门禁时不得合并。

## 10. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| GitHub production wiring 泄漏凭据 | 强类型 factory、Credential Bridge、脱敏测试、禁止含 token remote URL |
| Source 统一演变为大范围重写 | 通过 SkillSourceResolver 逐个迁移调用方，并增加行为一致性测试 |
| 事务抽象破坏稳定流程 | 先用于 Restore，再使用故障注入逐项迁移既有操作 |
| E2E 缓慢或不稳定 | 使用 local remote 与受控 HTTP；真实授权保留为人工验收 |
| 崩溃后 runtime.lock 阻塞用户 | lock owner metadata、stale detection、journal recovery、Doctor 集成 |
| Schema migration 破坏未知数据 | 版本化 fixture、迁移前备份、幂等验证与降级诊断 |
| P2 扩展拖延发布 | 先发布核心产品，再交付可选 Agent adapter 与条件性 package 拆分 |

## 11. 完成定义

满足以下条件时，整条优化路线完成：

1. P0 GitHub/Git 与 Managed Restore 旅程通过默认 production wiring 工作。
2. 主要用户旅程受 hermetic E2E 和当前平台验收证据保护。
3. Source 与 Lifecycle 在 CLI、Interactive CLI、Web 中行为一致。
4. 所有写操作均加锁、可恢复、可迁移、可诊断。
5. Package 可从干净环境 pack、安装，并具有准确发布 metadata。
6. 路线包含的 P2 Agent adapter 均通过共享 conformance suite。
7. 条件性 TUI 与 Web Server 拆分已被真实需求证明并实现，或明确保持不做且不存在未满足用户需求。
