# Skillbox 多端同步与冲突处理实现计划

**关联设计：** [多端同步与冲突处理设计](../specs/2026-08-13-multidevice-sync-conflict-design.md)  
**范围：** 用 Repository 级 `SyncTransaction` 取代 transport-only `pull/push` 同步路径，提供语义三方合并、可恢复冲突会话及 CLI/Web UI 解决入口。

## 执行原则

- 先完成 Core 的确定性合并与安全事务，再接入 CLI 和 Web；UI 不得包含 Git 语义或自行写文件。
- 所有 Repository tree 的合并在隔离目录进行；active worktree 与 Runtime 均在 Repository commit 成功前保持不变。
- 所有新写入使用现有 operation lock、路径安全与 atomic write 基础设施；不保存 token，不 force push。
- 每一步均先添加失败测试，再写最小实现；测试使用真实 Git process 的 hermetic fixture，不能只使用 fake port。

## 阶段 1：同步领域模型、错误与 Git 读取能力

### 1.1 定义公开同步模型

**新增：**

- `packages/core/src/sync/conflicts.ts`
- `packages/core/src/sync/conflicts.test.ts`

**修改：**

- `packages/core/src/sync/types.ts`
- `packages/core/src/sync/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/errors.ts`
- `packages/core/src/errors.test.ts`

**实现：**

1. 定义 `SyncRequest`、`SyncOutcome`、`SyncSummary`、`SyncBlocker`、`SyncRecovery`、`ConflictSession`、`SyncConflict`、`ConflictValue`、`ConflictType`、`ConflictResolution`、`ResolveConflictsRequest`。
2. 将 `RepositorySync.sync()` 改为返回 `Promise<SyncOutcome>`，增加 `resolveConflicts()` 与 `restoreSnapshot()`；保留 connect/disconnect/status 的兼容行为。
3. 新增稳定错误码：已存在 Git merge state、同步被阻止、冲突会话不存在/过期、冲突 resolution 不合法、snapshot 不存在/恢复失败、验证失败。所有面向用户的错误均标记可恢复性与安全恢复提示。
4. 扩展 `RepositorySyncEvent`，支持 preflight、fetch、snapshot、merge、validate、commit、retry-push、reconcile、conflicts 等无 Git 术语的进度事件。

**测试：**

- 公共 type 与 error code 的稳定性测试。
- `ConflictSession` JSON round-trip、未知 version 拒绝、token 字符串不在 serialize 输出中。
- conflict 的 allowed/recommended resolution 与 destructive 标记的基本不变量测试。

### 1.2 扩展 Git port，但不把 Git 冲突交给 UI

**修改：**

- `packages/core/src/git/git-client.ts`
- `packages/core/src/git/git-client.test.ts`
- `packages/core/src/git/index.ts`
- `packages/core/src/sync/types.ts`

**实现：**

1. 增加 `fetch`、读取当前/upstream revision、读取 merge base、以 revision 读取指定文件/tree、创建/删除私有 ref、创建隔离 worktree 或等价临时 tree 的 Git API。
2. 增加安全的 tree materialization API：只接受已验证 revision、所有路径经现有 path-safety 检查、临时目录固定在 transaction root。
3. 把非 fast-forward push 转换为现有 `GIT_PUSH_REJECTED`，保留本地 commit；fetch/retry 决策交给 transaction，而非 `GitClient`。
4. 保持 credential bridge 的 process-scoped 行为，所有新增 Git 命令继续使用 `authOptions()`。

**测试：**

- 使用 bare remote 验证 merge base、tree 读取、private snapshot ref 与 ref cleanup。
- detached HEAD、无 upstream、无 remote、不可达 remote 的 recoverable 行为。
- 断言 remote URL、argv、error、日志中都不包含测试 token。

## 阶段 2：Snapshot、事务持久化与 Repository 校验

### 2.1 实现同步 Snapshot 与 conflict-session store

**新增：**

- `packages/core/src/sync/snapshot-service.ts`
- `packages/core/src/sync/snapshot-service.test.ts`
- `packages/core/src/sync/conflict-session-store.ts`
- `packages/core/src/sync/conflict-session-store.test.ts`

**修改：**

- `packages/core/src/runtime/paths.ts`
- `packages/core/src/runtime/paths.test.ts`
- `packages/core/src/operations/*`（复用现有 operation lock/journal；不得创建第二套并发锁）

**实现：**

1. 在 `~/.skillbox/state/sync/` 下定义 snapshot、session 与临时 tree 的私有目录；为每项写入 schema version、repository identity、创建/过期时间。
2. `SnapshotService.create()` 保存 HEAD/ref、dirty managed file backup 和 transaction metadata；返回展示安全的 restore-point ID。
3. `restore()` 仅恢复该 Repository 的 managed paths 与 private ref 指向；先验证 repository identity，拒绝跨仓库恢复。
4. `ConflictSessionStore` 原子写入、读取、删除和过期清理 session；session 只保存 object ID、相对路径和用户可见 preview，不保存 Git credentials 或绝对 Runtime 路径。
5. 在 operation lock 下运行整个 transaction，阻止 CLI 与 Web 同时同步或解决同一 session。

**测试：**

- snapshot 创建后可以恢复 dirty managed paths；不改变 unmanaged file。
- restore 失败、repository mismatch、过期/损坏 session 均返回 typed recovery error。
- 断言并发 transaction 只能有一个获取 operation lock。

### 2.2 建立 RepositoryValidator

**新增：**

- `packages/core/src/sync/repository-validator.ts`
- `packages/core/src/sync/repository-validator.test.ts`

**实现：**

1. 在隔离合并 tree 上读取并 validate manifest，验证 alias、mode/source/upstream 生命周期约束、Skill 目录结构、安全 path 与 symlink。
2. 调用现有 lockfile/manifest 序列化和完整性设施，确保可重现的 canonical output。
3. 验证失败只返回诊断结果，不写 active Repository，也不触发 Runtime reconcile。

**测试：**

- 无效 YAML、重复 alias、非法 source/mode、缺失 `SKILL.md`、路径逃逸、非法 symlink。
- 同一输入产出字节稳定的 manifest/lockfile。

## 阶段 3：语义三方合并

### 3.1 ManifestMergeService

**新增：**

- `packages/core/src/sync/manifest-merge.ts`
- `packages/core/src/sync/manifest-merge.test.ts`

**实现：**

1. 输入 Base/Local/Remote parse 后的 `SkillboxManifest`，按 `skills[alias]` 作为一级单元输出 merged manifest 与 `SyncConflict[]`。
2. 实现通用三方 scalar 规则：单侧改动取该侧；双方改为相同值取共同值；双方不同则 conflict。
3. 对 `agents` 使用集合三方合并：不同 agent ID 的改动自动合并；同一 membership 的相反改动产生 `manifest-field` conflict。
4. 对 `metadata` 递归合并；对 `mode`、`source`、`upstream` 与不兼容 revision 生成 `mode`、`source`、`lifecycle` conflict，不允许 last-write-wins。
5. 实现 delete-vs-unchanged 自动删除，delete-vs-modify 产生 `delete-modify` 且默认建议保留修改。
6. 使用现有确定性 serializer 生成最终 YAML，杜绝文本 YAML merge。

**测试：**

- A 新增 X、B 新增 Y；A 改 X、B 改 Y；同 skill 不同字段；示例中的 `enabled` + `agents` 合并。
- 相同字段相同改动、相同字段冲突、agent 对立修改、metadata 深层冲突。
- delete-vs-unchanged、delete-vs-modify、managed-vs-forked、source-vs-source。

### 3.2 SkillTreeMergeService 与 LockResolver

**新增：**

- `packages/core/src/sync/skill-tree-merge.ts`
- `packages/core/src/sync/skill-tree-merge.test.ts`
- `packages/core/src/sync/lock-resolver.ts`
- `packages/core/src/sync/lock-resolver.test.ts`

**实现：**

1. 对每个 alias/path 进行三方 tree diff；只在一侧改动与不同 path 改动自动合并。
2. 文本文件使用隔离的三方 merge：非重叠 hunk 自动合并，重叠且内容不同产生 `content` conflict；二进制双改直接产生 conflict。
3. 绝不将 conflict marker 写到合并 tree 或 active Repository；conflict 仅携带有长度限制、已脱敏的 Base/Local/Remote preview。
4. manifest/content 合并成功后忽略三方 lockfile，调用 `LockResolver` 从 merged manifest/tree 重建 `skillbox.lock`，保留 exact revision 与 integrity。
5. 为 `keep-both` 提供 deterministic alias allocator，处理日期、设备标签清理和已存在 alias 的碰撞。

**测试：**

- 同一 Skill 的不同文件、同一文件不同区域、同一块不同修改、二进制双改。
- lockfile conflict 永远不会出现在 `SyncConflict` 中。
- keep-both 复制内容/manifest 后能成功 resolve/validate，且 alias 防碰撞。

## 阶段 4：SyncTransaction 与自动重试

### 4.1 实现 transaction orchestration

**新增：**

- `packages/core/src/sync/sync-transaction.ts`
- `packages/core/src/sync/sync-transaction.test.ts`

**修改：**

- `packages/core/src/sync/repository-sync.ts`
- `packages/core/src/sync/repository-sync.test.ts`
- `packages/core/src/sync/factory.ts`

**实现：**

1. 将同步路径收敛为 `RepositorySyncService -> SyncTransaction`；connect/disconnect 不改语义。
2. 实现 fixed flow：preflight → fetch → base/local/remote → snapshot → semantic merge → validate → managed-path commit → push → reconcile。
3. 发现语义 conflict 时持久化 `ConflictSession` 并返回 `{ kind: 'conflicts' }`，不写 active worktree、不改 Runtime。
4. Push 被拒绝时重新 fetch、重新计算三方版本并 retry；默认最多三次总尝试。远端反复前进后返回 typed blocker 或新 conflict session。
5. commit 后才激活 Repository tree；reconcile 失败只报告可重试 Runtime recovery，绝不回滚已有效发布的 Repository commit。
6. 在 validation/activation/resolution 失败时调用 snapshot restore；保留失败诊断与 session。

**测试：**

- clean fast-forward、纯本地 push、L1/L2 自动合并、L3/L4 session 返回。
- B 在 A fetch 后 push，A 首次 push rejected，自动 fetch/recompute/retry 成功。
- 达到重试上限后没有 force push、没有数据丢失。
- validation/activation 失败回滚；reconcile 失败保留 commit 与 Runtime 未部分修改的保证。

### 4.2 接入真实 Git E2E fixture

**新增/修改：**

- `packages/testing/src/git-fixture.ts`
- `packages/testing/src/git-fixture.test.ts`
- `packages/core/src/sync/sync-transaction.e2e.test.ts`
- `packages/core/src/sync/repository-sync.e2e.test.ts`

**实现：**

1. 扩展已有 bare remote fixture，创建两个独立 Repository clone、独立 HOME/state/runtime root 和可控的 Git transport。
2. 使用真实 `GitClient`、真实 filesystem、真实 bare remote；仅 GitHub HTTP/credential 边界可使用受控 fake。
3. 提供“在 A/B 指定阶段执行 hook”的测试工具，用于确定性触发 push rejection。

**测试矩阵：**

- 用户需求中的 A/B add、different skill、different field、same content、delete/modify、mode/source、push retry、三种 resolution、rollback、runtime failure 全部以真实 Git 执行。
- Windows、macOS、Linux CI 执行；对 Windows cleanup 使用已有序列化/重试模式，避免未完成异步读取造成 `ENOTEMPTY`。

## 阶段 5：CLI 体验

### 5.1 添加 conflict command 与交互式 resolver

**新增：**

- `packages/cli/src/sync/conflicts.ts`
- `packages/cli/src/sync/conflicts.test.ts`

**修改：**

- `packages/cli/src/program.ts`
- `packages/cli/src/sync/pipeline.ts`
- `packages/cli/src/sync/types.ts`
- `packages/cli/src/exit-codes.ts`
- `packages/cli/src/index.test.ts`

**实现：**

1. 删除正常 sync 流程中“用户手工解决 Git conflict 再重试”的提示；转而消费 Core `SyncOutcome`。
2. 加入 `skillbox conflicts`（列出 pending session）与 `skillbox conflicts resolve`（逐项交互选择）；支持 advanced `--conflict=local|remote|keep-both`。
3. 默认文案使用“这台设备/另一台设备”；只显示 Skill alias、可读摘要、推荐项和恢复点，不显示 `HEAD`/`origin`/Git marker。
4. 为文本冲突提供安全的 diff 展示；编辑合并结果只允许明确进入 advanced flow 后使用。
5. 返回 conflict 时使用 exit code 3；需要用户选择不视为 generic failure。

**测试：**

- clean sync、自动合并、pending conflict 列表、local/remote/keep-both resolution。
- 断言普通 output 不含 Git marker、`HEAD`、`origin`、ours、theirs。
- advanced flag 的无 TTY、无有效 session、过期 session 与 destructive confirmation。

## 阶段 6：本地 Web API 与冲突解决页

### 6.1 Server 和 API client

**修改：**

- `packages/cli/src/web/types.ts`
- `packages/cli/src/web/services.ts`
- `packages/cli/src/web/app.ts`
- `packages/cli/src/web/app.test.ts`
- `apps/web/src/api.ts`
- `apps/web/src/api.test.ts`（如当前不存在则新增）

**实现：**

1. `createWebServices()` 注入 `RepositorySync`，不允许 route 直接访问 Git 或 filesystem。
2. 增加 `GET /api/sync/status`、`POST /api/sync`、`GET /api/conflicts`、`GET /api/conflicts/:id`、`POST /api/conflicts/:id/resolve`、`POST /api/sync/snapshots/:id/restore`。
3. 复用现有 API error envelope；将 operation lock 中的状态映射为可读、可恢复的 409/423 类错误，不泄露 Git 命令/凭据。
4. 在 `apps/web/src/api.ts` 定义与 Core 保持一致的 presentation DTO；禁止把 Base/Local/Remote 内部名、绝对路径或 token 传至浏览器。

**测试：**

- route 从 Core stub 返回 completed/conflicts/blocked 的序列化与状态码。
- resolve 请求的 schema 验证、过期 session、重复提交、operation locked。
- API response、error response 与日志均无 token/Git 内部术语。

### 6.2 Web UI 冲突中心

**新增：**

- `apps/web/src/pages/SyncPage.tsx`
- `apps/web/src/pages/ConflictResolutionPage.tsx`
- `apps/web/src/pages/ConflictResolutionPage.test.tsx`

**修改：**

- `apps/web/src/App.tsx`
- `apps/web/src/queries.ts`
- `apps/web/src/styles.css`
- `apps/web/src/format.ts`

**实现：**

1. 增加同步状态入口：完成态显示已同步/自动合并数量；冲突态跳转到 conflict center。
2. conflict center 先按 Skill 分组，再显示字段/文件细节；primary action 为“使用这台设备”“使用另一台设备”“两个都保留”，并展示推荐项。
3. Delete-vs-Modify、Mode/Source/Lifecycle conflict 使用专用解释和破坏性确认；显示“同步前已创建恢复点”和恢复动作。
4. “查看差异”采用可访问的并排文本 diff；二进制仅显示“无法预览，需选择版本”。默认不显示 Git marker 或 Git 术语。
5. resolution 成功后刷新 status、skills、agents；仅 Core 成功返回后展示完成通知。

**测试：**

- 四类视图：L0-L2 自动完成、内容冲突、delete/modify、lifecycle/source conflict。
- 三种选择、确认取消、keep-both 命名、恢复 snapshot、network/operation 错误。
- 无障碍：键盘可选择 action、对话框 focus 管理、错误消息可读。

## 阶段 7：完整验证、文档与发布门槛

**修改：**

- `README.md`
- `README.zh-CN.md`
- `docs/e2e-acceptance.md`
- `GAP_ANALYSIS.md`

**执行：**

1. 更新多设备 restore/sync 文档：普通用户从 Web/interactive flow 解决冲突；CLI 命令只作为高级入口。
2. 更新 acceptance walkthrough，包含两个设备、一个自动 merge、一个 keep-both、一个 delete/modify、一个 push retry 和 Runtime reconcile 验收。
3. 运行格式化、lint、typecheck、unit/integration/E2E、build；在 Windows 上验证临时 fixture cleanup。
4. 人工验收：两个真实设备或两个隔离用户目录同步；确认 UI 不暴露 Git marker、默认不丢数据、失败时 Runtime 不受影响。
5. 对 token 泄漏进行全量输出与 state 文件扫描；新增回归测试后再发布。

## 完成标准

- L0-L2 无需用户介入；L3-L4 返回持久、可恢复的语义 conflict session。
- 普通 CLI/Web 用户无需执行 Git 命令，也不会看到 Git conflict marker 或 Git 内部术语。
- `keep-both`、delete/modify、mode/source/lifecycle resolution 都有数据保留与恢复点保证。
- remote advanced 时能够自动 fetch/recompute/retry，且不 force push；超过上限安全停止。
- Repository transaction 成功前 Runtime 不变；Runtime failure 不损坏已验证的 Repository。
- 真实 Repository A + Repository B + bare remote E2E 通过，并在三平台 CI 稳定执行。
