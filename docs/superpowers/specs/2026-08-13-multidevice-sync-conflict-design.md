# Skillbox 多端同步与冲突处理设计

**状态：** 提议  
**日期：** 2026-08-13  
**范围：** 面向 CLI 与本地 Web UI 的 Repository 级多设备同步、语义冲突检测与解决。

## 1. 目标

Skillbox 使用 Git 作为同步协议，并以 GitHub 作为默认托管 Provider。Git 继续负责历史、传输、原子提交和远端并发控制；Skillbox 负责领域语义和用户体验。

产品目标是 **Git-level reliability, iCloud-level UX**。普通用户不需要看到 Git 冲突标记，也不需要理解 `HEAD`、`origin`、merge、rebase、reset、ours 或 theirs。

Repository 是跨设备的 Source of Truth：

```text
skillbox.yaml       期望状态
skillbox.lock       已解析状态
skills/             Local、Forked、Vendored Skill 内容
```

下列 Runtime State 仅保留在本机，不进入同步：

```text
~/.skillbox/library/
~/.skillbox/cache/
~/.skillbox/state/
Agent Skill Directories
```

## 2. 非目标

- Skillbox 不是通用 Git GUI。
- 默认 UI 不展示分支、remote、commit 或原始 Git 冲突文本。
- 第一阶段不做实时协作编辑，只解决同步时发现的并发修改。
- 对破坏性或语义不明确的修改，系统不静默选择其中一方。

高级用户可以使用 `--conflict=local`、`--conflict=remote`、`--conflict=keep-both` 等 CLI 参数，但它们不是主要用户路径。

## 3. 数据安全不变量

1. **绝不丢失用户数据。** 无法判断意图的修改必须交由用户选择；可以安全复制时，始终提供 `keep-both`。
2. **绝不破坏可工作的 Runtime。** Repository 成功合并、校验与提交之前，不得改动 Agent link、canonical library、cache 或其他 Runtime State。
3. **默认不暴露原始 Git Conflict。** Git 冲突必须先转换为 Skillbox 语义冲突，CLI/Web UI 不直接呈现 Git 冲突文本。
4. **仅在安全时自动合并。** 自动合并必须得到确定、无重叠的三方合并结果。
5. **破坏性操作前先保留恢复点。** 同步、解决、删除、Restore 或生命周期转换前都必须有可恢复状态。
6. **Repository 优先于 Runtime。** 顺序固定为合并、校验、提交、激活 Repository，再 Reconcile Runtime。
7. **Lockfile 是派生数据。** 用户解决 Desired State 与内容，不解决 `skillbox.lock` 文本。

## 4. 与当前架构的衔接

现有 `RepositorySyncService` 负责 GitHub 授权、Repository 创建/选择、remote binding 和基础 pull/push transport；现有 CLI `SyncService` 负责 scan、secret scan、reconcile、managed-path commit 与 push。Web UI 目前可展示 `conflict` 状态，但没有 Repository 同步冲突处理流程。

新设计以 Repository transaction 取代 transport-only sync，同时保持已有分层：

```text
GitHub Integration：认证、Repository API、凭据生命周期
Git Engine：        Repository 检查、fetch、object/ref 读取、commit、push
Skillbox Core：     Snapshot、语义合并、校验、冲突解决、激活
CLI / Web：         仅负责进度呈现和用户友好选择
```

现有 lifecycle 三方合并及其 continue/abort 语义可作为实现模式复用，但 Repository 同步是独立 transaction，不能直接复用 lifecycle 的状态文件。

## 5. 架构

```text
RepositorySyncService
  -> SyncTransaction
       -> SnapshotService
       -> GitEngine
       -> SyncMergeService
            -> ManifestMergeService
            -> SkillTreeMergeService
            -> LockResolver
            -> ConflictDetector
       -> ConflictResolver
       -> RepositoryValidator
       -> ReconcileService
```

### 5.1 Core 合约

`RepositorySync` 增加返回结构化结果的操作，不再将原始 Git merge conflict 抛给呈现层：

```ts
interface RepositorySync {
  status(): Promise<RepositorySyncStatus>
  connect(options?: EnsureRepositoryOptions): Promise<RepositorySyncConnectResult>
  disconnect(): Promise<void>
  sync(input?: SyncRequest): Promise<SyncOutcome>
  resolveConflicts(input: ResolveConflictsRequest): Promise<SyncOutcome>
  restoreSnapshot(snapshotId: string): Promise<void>
}

type SyncOutcome =
  | { kind: 'completed'; summary: SyncSummary }
  | { kind: 'conflicts'; session: ConflictSession }
  | { kind: 'blocked'; reason: SyncBlocker; recovery: SyncRecovery }

interface SyncConflict {
  id: string
  type: ConflictType
  skillAlias?: string
  path?: string
  field?: string
  base?: ConflictValue
  local?: ConflictValue
  remote?: ConflictValue
  allowedResolutions: ConflictResolution[]
  recommendedResolution?: ConflictResolution
  destructive: boolean
}

type ConflictType =
  | 'content'
  | 'delete-modify'
  | 'manifest-field'
  | 'mode'
  | 'source'
  | 'lifecycle'

type ConflictResolution =
  | 'local'
  | 'remote'
  | 'keep-both'
  | 'merged'
  | 'delete'
  | 'restore'
```

`local` 与 `remote` 仅是 Core 内部术语。呈现层必须转换为“这台设备”与“另一台设备”，并尽可能显示设备标签与修改时间。

### 5.2 持久化冲突会话

当需要用户决定时，Core 在 Skillbox state root 中写入版本化 `ConflictSession`。其中记录不可变的 Base/Local/Remote object ID、snapshot ID、候选合并 tree、冲突项及过期信息；绝不记录 access token。

解决时采用 optimistic concurrency：`resolveConflicts` 必须先确认远端 tip 仍与创建会话时一致。若远端已前进，则重新 fetch 并计算新会话，不能把陈旧选择应用到新历史上。

## 6. 同步事务

```text
preflight -> fetch -> 检查 base/local/remote -> snapshot -> semantic merge
  -> 有冲突？--是--> 持久化会话并返回 UI
  -> 否 -------------> validate -> commit 合并后 Repository -> push
                                            -> 被拒绝？fetch/重新计算/重试
                                                        -> reconcile Runtime -> 完成
```

详细规则：

1. **Preflight：** 拒绝已有未解决 Git merge state；检查 dirty managed paths；检查是否已有 Skillbox conflict session。未管理文件不得被暂存或重写。
2. **Fetch：** 继续使用现有 process-scoped credential bridge。凭据不得出现在 URL、参数、state、日志、snapshot 或 API response。
3. **确定版本：** 选择 Git merge base，在隔离临时 worktree/directory 中物化 `Base`、`Local`、`Remote` Repository tree；不能在 active worktree 中直接 merge。
4. **Snapshot：** 创建私有 ref，如 `refs/skillbox/snapshots/<id>`，并备份 dirty managed files。UI 仅显示“同步前已创建恢复点”。
5. **语义合并：** 按下文规则合并 manifest、skill tree 和派生 lockfile。
6. **校验：** 解析 manifest，校验 source/mode 不变量与 Skill 结构，生成 canonical lockfile，然后校验完整性与 Repository path。
7. **提交与激活：** 仅在校验通过后创建一个 managed-path commit；仅在 commit 存在后把 tree 激活到 active Repository。
8. **Push：** 正常 push。被拒绝时从 fetch 与重新计算开始，最多共三次；绝不 force push。
9. **Reconcile：** 仅在远端发布成功后（或明确支持的 offline outcome）重建 library state 与 Agent link。Reconcile 失败保留有效 Repository commit，并单独报告 Runtime recovery。

校验、激活或冲突解决失败时，恢复 snapshot。第 9 步之前 Runtime 必须保持不变。

## 7. 三方语义合并

所有合并均比较 `Base`、`Local` 与 `Remote`。变更判断必须相对 Base，而非只比较 Local 与 Remote。

### 7.1 冲突等级

| 等级 | 情况 | 处理 |
| --- | --- | --- |
| L0 | Local 未改、Remote 已改 | 自动 fast-forward 并 reconcile。 |
| L1 | 不同 Skill alias 被修改 | 自动合并。 |
| L2 | 同一 Skill 的独立字段/文件被修改 | 自动字段/文件三方合并。 |
| L3 | 相同内容区域被不同方式修改 | 创建用户内容冲突。 |
| L4 | Delete/Modify、source/mode/lifecycle 修改 | 创建用户语义冲突。 |

### 7.2 Manifest 合并

`skillbox.yaml` 必须先 parse 再合并，最后确定性 serialize；绝不以 YAML 文本直接解决冲突。

一级合并单元为 `skills[alias]`：

- 只在一侧新增的 alias 直接保留。
- 不同 alias 的独立修改自动合并。
- Delete 对未变 alias 时删除。
- Delete 对 Modify 时生成 `delete-modify`。
- 同一 alias 继续递归字段级合并。

普通 scalar 字段遵循：只有一侧相对 Base 改变时使用该值；两侧相对 Base 改变但值相同，使用共同值；其他情形创建 `manifest-field`，除非该字段有专门规则。

`agents` 是集合：两侧对不同 agent ID 的增删可以合并；同一 agent membership 被相反方式修改时冲突。`metadata` 递归使用同一规则。

定义 lifecycle identity 的字段（`mode`、`source`、`upstream` 及不兼容 source revision）不允许 last-write-wins。冲突时创建 `mode`、`source` 或 `lifecycle` conflict。

### 7.3 Lockfile 策略

`skillbox.lock` 不参与三方合并。manifest/content 合并且校验通过后，`LockResolver` 根据已解析 manifest 与 materialized skill tree 生成新的 canonical lockfile，并保留 exact revision、integrity 和 pinned managed source 规则。lock resolution 失败时阻止 transaction 并恢复 snapshot。

### 7.4 Skill Tree 合并

`skills/<alias>/` 按 alias 与 path 合并：

- 不同 path 自动合并。
- 二进制文件被双方修改时产生 `content` conflict；不得写入二进制冲突标记。
- 文本文件在隔离 tree 中使用三方合并；非重叠修改自动合并。
- 重叠且不同的文本修改产生 `content` conflict，其中包含安全的 Base/Local/Remote preview。
- Skill 删除与已修改文件相遇时，在 Skill 级别产生 `delete-modify`。

不得把 Git conflict marker 写入 active Repository，也不得向普通用户展示。

### 7.5 Lifecycle 冲突

Managed、Forked、Local、Vendored 有不同的所有权与 Restore 语义。冲突的 mode/source change 不能作为普通字段合并。

示例与默认建议：

| 情况 | 冲突 | 默认建议 |
| --- | --- | --- |
| Delete vs Modify | `delete-modify` | 保留被修改 Skill。 |
| Managed vs Forked | `mode` / `lifecycle` | 保留 Forked Skill。 |
| 两个不同 source | `source` | alias 可分离时 Keep Both，否则由用户选择。 |
| Vendored vs Managed | `mode` / `lifecycle` | 保留 Vendored 内容。 |

Resolver 必须整合已有 managed restore、fork、vendor、backup 与 rollback 服务。覆盖或 Restore 内容前必须创建 backup。

## 8. 用户解决模型

CLI 与 Web UI 提供以 Skill 为中心的 conflict center，而不是以 Git file 为中心的视图。

```text
my-review 需要你的决定

这台设备今天 03:31 修改。
另一台设备今天 03:29 修改。

[使用这台设备] [使用另一台设备] [两个都保留] [查看差异]
```

文本冲突的“查看差异”展示并排、可读的变化；高级用户可编辑合并后的结果。列名不得使用 `HEAD`、`origin`、`ours` 或 `theirs`。

`keep-both` 是一等 Resolution。原 alias 保留用户选定的主版本；另一个版本使用确定且防碰撞的 alias，例如 `my-review-conflict-2026-08-13`，可选地附加经清理的设备标签。Resolver 必须原子更新 manifest、files 及重新生成的 lockfile。

Delete-vs-Modify 显示：

```text
这台设备删除了 Skill A，但另一台设备修改了它。

[保留修改后的 Skill] [删除它] [保留副本后删除]
```

默认建议是保留修改后的 Skill。任何破坏性选择均须显式确认，并显示恢复点。

## 9. CLI 与 Web API

普通 CLI 仅展示进度与简短的决定提示。对 L0-L2 显示“已自动合并”，只列出需要用户处理的 Skill。

```text
skillbox sync

✓ 正在同步
✓ 已自动合并 4 项更改

1 个 Skill 需要决定：my-review
```

命令：

```text
skillbox conflicts
skillbox conflicts resolve
skillbox sync --conflict=local|remote|keep-both
```

参数值是高级别名，不能改变普通模式的展示语言。

本地 Web server 增加与下列等价的端点：

```text
GET  /api/sync/status
POST /api/sync
GET  /api/conflicts
GET  /api/conflicts/:id
POST /api/conflicts/:id/resolve
POST /api/sync/snapshots/:id/restore
```

所有 mutation endpoint 通过 operation lock 串行化，并返回 typed `SyncOutcome`。Web UI 增加 sync status 入口与 conflict-resolution page；浏览器不执行 shell command。

## 10. 错误处理与恢复

- Manifest 无效、unsafe path、lock resolution 失败或 Repository validation 失败：中止并恢复 snapshot。
- Remote push 被拒绝：fetch、重新计算并最多三次尝试；之后返回 conflict session 或可重试 sync blocker。
- 已存在原始 Git merge state：返回可恢复 blocked state。migration/recovery command 可安全检查并转换支持的状态，但普通 sync 绝不覆盖它。
- Runtime reconcile 失败：保留已提交 Repository 结果，报告失败的 Runtime step 并支持 retry reconcile；不因本地 linking 失败而回滚已发布 Repository。
- Snapshot restore 失败：返回高优先级可恢复错误，包含 snapshot ID，并保留全部诊断状态。

## 11. 测试计划

Unit test 覆盖 manifest field rule、alias 处理、agent set operation、lock regeneration、duplicate alias naming、lifecycle policy 和 resolution idempotency。

Hermetic Git E2E 使用 Repository A、Repository B 与 bare remote；采用真实 Git process 与隔离 HOME/runtime root。必须覆盖：

1. A 新增 X，B 新增 Y。
2. A 修改 X，B 修改 Y。
3. A 修改 `enabled`，B 修改 `agents`。
4. 双方修改同一 `SKILL.md` 区域。
5. Delete vs Modify。
6. Managed 转 Forked 的并发修改。
7. 两个冲突 source change。
8. A fetch 后 B push，导致 A push rejected，随后 fetch/recompute/retry。
9. 分别以 local、remote、keep-both 解决。
10. Validation failure 回滚 Repository snapshot。
11. Runtime reconcile failure 保留已校验、已提交的 Repository，且不部分改动 Runtime。
12. Token/authorization 不得出现在 ref、snapshot、log、CLI output、API payload、URL 或 process argument。

## 12. 交付顺序

1. 增加 Core domain type、snapshot/operation persistence 与 Git object/tree 读取能力。
2. 实现确定性 manifest merge 与 lock regeneration，并补齐 unit coverage。
3. 实现隔离 skill-tree merge 与 conflict session persistence。
4. 以 `SyncTransaction` 替换 transport-only sync orchestration，包含 push retry 与 rollback。
5. 增加 CLI conflict command 与用户友好呈现。
6. 增加 Web API 与 conflict-resolution page。
7. 增加真实多 Repository Git E2E 与跨平台 CI coverage。

该顺序让 Repository correctness 先于 UI polish，并确保每一个 UI action 都映射到经过测试的 Core transaction。
