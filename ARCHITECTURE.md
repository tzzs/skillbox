# Skillbox Architecture

> File: `ARCHITECTURE.md`
> Status: Draft
> Version: 0.2
> Last Updated: 2026-08-09

---

# 1. Architecture Goals

Skillbox 的架构目标是构建一个：

> **Local-first、Git-native、UI-agnostic、Agent-agnostic 的 Agent Skills Package Manager。**

系统必须同时支持：

```text
CLI
Interactive CLI / TUI
Local Web UI
```

并确保这些入口：

> **共享完全相同的核心业务逻辑。**

禁止出现：

```text
CLI 一套逻辑
Web 一套逻辑
TUI 再写一套逻辑
```

所有核心能力必须集中到：

```text
@skillbox/core
```

中。

---

# 2. High-level Architecture

整体架构：

```text
                     ┌─────────────────────┐
                     │      Skillbox       │
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │   @skillbox/core    │
                     └──────────┬──────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
          ▼                     ▼                     ▼
   Skill Manager          Agent Manager       Repository Service
          │                     │               │             │
          ▼                     ▼               ▼             ▼
 Registry Manager         Agent Adapters  GitHub Integration Git Engine
          │                                   │               │
          ▼                                   ▼               ▼
 Registry Providers                    GitHub REST API   System Git

          │
          ▼

     Local Filesystem
```

UI 层：

```text
                        @skillbox/core
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
           CLI              TUI            Web Server
             │                │                │
             │                │                ▼
             │                │            Web Frontend
             │                │
             └────────────────┴────────────────┘
```

---

# 3. Architectural Principles

## 3.1 Core First

所有业务规则必须放在：

```text
packages/core
```

例如：

```text
Skill install
Skill remove
Skill update
Agent link
Agent unlink
Git sync
Fork
Vendor
Diff
Merge
Security scan
```

UI 不允许直接修改核心数据。

错误示例：

```text
Web UI
   ↓
fs.writeFile(SKILL.md)
```

正确方式：

```text
Web UI
   ↓
SkillService.update()
   ↓
Filesystem Layer
```

---

# 4. UI-agnostic

Core 不应该依赖：

```text
React
Ink
Browser APIs
DOM
Terminal APIs
```

例如禁止：

```ts
import React from 'react'
```

出现在：

```text
packages/core/
```

Core 只返回：

```ts
Result
Domain Object
Event
Error
```

由 UI 决定如何展示。

---

# 5. Agent-agnostic

Core 不直接包含：

```text
if claude
if codex
if cursor
```

这种逻辑。

统一通过：

```text
AgentAdapter
```

处理。

例如：

```ts
interface AgentAdapter {
  id: string
  name: string

  detect(): Promise<AgentDetectionResult>

  getVersion(): Promise<string | null>

  getGlobalSkillDirectories(): Promise<string[]>

  getProjectSkillDirectories(
    projectPath: string
  ): Promise<string[]>

  scanSkills(): Promise<AgentInstalledSkill[]>

  linkSkill(
    skill: CanonicalSkill,
    options?: LinkOptions
  ): Promise<void>

  unlinkSkill(
    skill: CanonicalSkill
  ): Promise<void>
}
```

---

# 6. Registry-agnostic

Skillbox 不绑定：

```text
skills.sh
```

或：

```text
GitHub
```

所有远程来源通过：

```text
RegistryProvider
```

抽象。

```ts
interface RegistryProvider {
  id: string

  canHandle(source: SkillSource): boolean

  search(
    query: string,
    options?: SearchOptions
  ): Promise<SkillSearchResult[]>

  resolve(
    source: SkillSource
  ): Promise<ResolvedSkill>

  download(
    resolved: ResolvedSkill
  ): Promise<DownloadedSkill>

  getLatestRevision?(
    resolved: ResolvedSkill
  ): Promise<SkillRevision | null>
}
```

---

# 7. Git-native

Skillbox 不重新实现版本控制。

Repository 中：

```text
Local Skill
Forked Skill
Vendored Skill
Manifest
Lockfile
```

直接由 Git 管理。

Skillbox Git Engine 只负责：

```text
init
status
pull
commit
push
sync
diff
conflict detection
```

底层优先使用系统 Git。

Git Engine 与 GitHub Integration 必须是两个独立模块：

```text
GitHub Integration             Git Engine
Authentication                init / clone
Current user                  fetch / pull
Repository list/create        commit / merge
Token refresh                 push / status
```

前者是云端 Provider 集成，后者是本地版本控制执行层。Git Engine 不应依赖 GitHub API；Generic Git 模式也不应依赖 GitHub 登录。

---

# 8. Local-first

Skillbox 核心运行不依赖远程服务器。

以下功能必须离线可用：

```text
list
create
edit
remove
agents
link
unlink
status
local diff
web
tui
```

需要网络的功能：

```text
search
install remote skill
update
GitHub pull
GitHub push
Marketplace
```

网络不可用不应影响本地 Library。

---

# 9. Recommended Technology Stack

推荐：

```text
Language:
TypeScript

Runtime:
Node.js

Package Manager:
pnpm

Monorepo:
pnpm workspace
```

最低 Node 版本建议：

```text
Node.js 20+
```

实际发布时可根据依赖决定是否提高。

---

# 10. Monorepo Structure

推荐：

```text
skillbox/
│
├── apps/
│   │
│   └── web/
│
├── packages/
│   │
│   ├── core/
│   │
│   ├── cli/
│   │
│   ├── tui/
│   │
│   ├── web-server/
│   │
│   ├── shared/
│   │
│   └── testing/
│
├── bin/
│   └── skillbox.mjs
│
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── eslint.config.js
└── README.md
```

也可以将：

```text
web-server
```

放进：

```text
packages/web
```

但建议前后端职责明确。

---

# 11. Core Package

目录建议：

```text
packages/core/
│
├── src/
│   │
│   ├── skills/
│   │   ├── skill-service.ts
│   │   ├── skill-resolver.ts
│   │   ├── skill-installer.ts
│   │   ├── skill-updater.ts
│   │   ├── skill-remover.ts
│   │   ├── skill-forker.ts
│   │   ├── skill-vendor.ts
│   │   ├── skill-diff.ts
│   │   └── skill-merge.ts
│   │
│   ├── agents/
│   │   ├── agent-service.ts
│   │   ├── agent-registry.ts
│   │   ├── adapter.ts
│   │   └── adapters/
│   │
│   ├── registries/
│   │   ├── registry-service.ts
│   │   ├── provider.ts
│   │   └── providers/
│   │
│   ├── git/
│   │   ├── git-service.ts
│   │   ├── sync-service.ts
│   │   └── repository.ts
│   │
│   ├── manifests/
│   │   ├── manifest-service.ts
│   │   ├── lock-service.ts
│   │   └── schema.ts
│   │
│   ├── security/
│   │   ├── skill-scanner.ts
│   │   ├── secret-scanner.ts
│   │   └── policies.ts
│   │
│   ├── filesystem/
│   │   ├── filesystem-service.ts
│   │   ├── links.ts
│   │   └── paths.ts
│   │
│   ├── config/
│   │   ├── config-service.ts
│   │   └── defaults.ts
│   │
│   ├── events/
│   │   └── event-bus.ts
│   │
│   ├── domain/
│   │   ├── skill.ts
│   │   ├── agent.ts
│   │   ├── source.ts
│   │   └── errors.ts
│   │
│   └── index.ts
│
└── package.json
```

---

# 12. Core Service Layer

推荐 Core 对外暴露少量高层 Service。

例如：

```ts
interface SkillService {
  list(
    options?: ListSkillOptions
  ): Promise<Skill[]>

  get(
    skillId: string
  ): Promise<Skill>

  create(
    input: CreateSkillInput
  ): Promise<Skill>

  install(
    input: InstallSkillInput
  ): Promise<Skill>

  remove(
    skillId: string
  ): Promise<void>

  update(
    skillId: string
  ): Promise<UpdateResult>

  fork(
    skillId: string
  ): Promise<ForkResult>

  vendor(
    skillId: string
  ): Promise<VendorResult>

  diff(
    skillId: string
  ): Promise<SkillDiff>

  merge(
    skillId: string,
    options?: MergeOptions
  ): Promise<MergeResult>
}
```

---

# 13. Agent Service

```ts
interface AgentService {
  detectAll(): Promise<Agent[]>

  list(): Promise<Agent[]>

  get(
    agentId: string
  ): Promise<Agent>

  getSkills(
    agentId: string
  ): Promise<InstalledSkill[]>

  enableSkill(
    agentId: string,
    skillId: string
  ): Promise<void>

  disableSkill(
    agentId: string,
    skillId: string
  ): Promise<void>

  reconcile(
    agentId?: string
  ): Promise<ReconcileResult>
}
```

---

# 14. Registry Service

```ts
interface RegistryService {
  search(
    query: string,
    options?: RegistrySearchOptions
  ): Promise<SkillSearchResult[]>

  resolve(
    source: SkillSource
  ): Promise<ResolvedSkill>

  install(
    source: SkillSource
  ): Promise<Skill>
}
```

Registry Service 本身不关心：

```text
skills.sh
GitHub
```

由 Provider Registry 自动选择。

---

# 15. Git Service

```ts
interface GitService {
  init(
    path: string
  ): Promise<void>

  status(): Promise<GitStatus>

  pull(
    options?: PullOptions
  ): Promise<PullResult>

  commit(
    message: string
  ): Promise<CommitResult>

  push(): Promise<PushResult>

  sync(
    options?: SyncOptions
  ): Promise<SyncResult>
}
```

---

## 15.1 Repository Service

Repository Service 编排 GitHub Integration 与 Git Service，但不把两者合并：

```ts
interface RepositoryService {
  connectGitHub(): Promise<GitHubConnection>
  createGitHubRepository(input: CreateRepositoryInput): Promise<RepositoryBinding>
  selectGitHubRepository(id: string): Promise<RepositoryBinding>
  connectGitRemote(remote: string): Promise<RepositoryBinding>
  disconnectGitHub(): Promise<void>
  sync(options?: SyncOptions): Promise<SyncResult>
}
```

它负责首次连接的幂等编排、Repository binding 和错误恢复；Git 操作仍委托给 Git Service。

---

## 15.2 GitHub Integration

云端同步 Provider 使用独立抽象：

```ts
interface SyncProvider {
  id: string
  connect(): Promise<ProviderConnection>
  listRepositories(): Promise<RemoteRepository[]>
  createRepository(input: CreateRepositoryInput): Promise<RemoteRepository>
  disconnect(): Promise<void>
}
```

V0.2 提供 `GitHubRepositoryProvider` 和不要求账号连接的 `GenericGitProvider`。后续 GitLab、Gitea、Bitbucket 或 self-hosted Git 不得迫使 Git Engine 改变职责。

```ts
interface GitHubService {
  startDeviceAuthorization(): Promise<DeviceAuthorization>
  pollDeviceAuthorization(deviceCode: string): Promise<GitHubConnection>
  getCurrentUser(): Promise<GitHubUser>
  listRepositories(): Promise<GitHubRepository[]>
  createRepository(input: CreateRepositoryInput): Promise<GitHubRepository>
  refreshAccessToken(): Promise<void>
  disconnect(): Promise<void>
}
```

GitHub Service 只处理 GitHub 官方 API、Device Flow、用户信息、Repository API 和 token 生命周期。它不得直接执行 Git 命令。

---

## 15.3 Credential Store

```ts
interface CredentialStore {
  get(key: CredentialKey): Promise<string | null>
  set(key: CredentialKey, value: string): Promise<void>
  delete(key: CredentialKey): Promise<void>
}
```

平台实现：

```text
macOS      Keychain
Windows    Credential Manager
Linux      Secret Service
```

Access token、refresh token 及其过期时间属于 Machine-specific secret state，不进入 Repository、Manifest、Lockfile 或普通 JSON config。

---

# 16. Manifest Service

```ts
interface ManifestService {
  read(): Promise<SkillboxManifest>

  write(
    manifest: SkillboxManifest
  ): Promise<void>

  addSkill(
    skill: ManifestSkillEntry
  ): Promise<void>

  removeSkill(
    skillId: string
  ): Promise<void>

  validate(): Promise<ValidationResult>
}
```

---

# 17. Lock Service

```ts
interface LockService {
  read(): Promise<SkillboxLockfile>

  resolve(): Promise<SkillboxLockfile>

  updateSkill(
    skill: ResolvedSkill
  ): Promise<void>

  removeSkill(
    skillId: string
  ): Promise<void>

  verifyIntegrity(): Promise<IntegrityResult>
}
```

---

# 18. Domain Model

核心 Skill Domain：

```ts
type SkillMode =
  | 'managed'
  | 'forked'
  | 'local'
  | 'vendored'
```

Skill：

```ts
interface Skill {
  id: string

  name: string

  description?: string

  mode: SkillMode

  source: SkillSource

  localPath: string

  revision?: string

  integrity?: string

  upstream?: SkillUpstream

  agents: string[]

  status: SkillStatus
}
```

---

# 19. SkillSource

推荐：

```ts
type SkillSource =
  | GitHubSkillSource
  | RegistrySkillSource
  | GitSkillSource
  | LocalSkillSource
```

例如：

```ts
interface GitHubSkillSource {
  type: 'github'

  repo: string

  path?: string

  ref?: string
}
```

---

# 20. Skill Status

状态与 Mode 分开。

Mode 表示：

```text
管理关系
```

Status 表示：

```text
当前运行状态
```

例如：

```ts
type SkillStatus =
  | 'ready'
  | 'modified'
  | 'outdated'
  | 'conflict'
  | 'missing'
  | 'broken'
```

例如：

```text
mode:
forked

status:
outdated
```

完全合理。

---

# 21. Canonical Library

推荐默认目录：

```text
~/.skillbox/
```

结构：

```text
~/.skillbox/
│
├── config.json
│
├── library/
│   │
│   ├── managed/
│   ├── local/
│   ├── forked/
│   └── vendored/
│
├── cache/
│
├── repositories/
│
├── state/
│
├── logs/
│
└── tmp/
```

不过需要注意：

> Git Repository 和 Runtime Library 不应强绑定为同一个目录。

---

# 22. Runtime Library vs Git Repository

建议区分：

```text
Runtime Library
```

和：

```text
Sync Repository
```

Runtime：

```text
~/.skillbox/library/
```

负责实际运行。

Git Repository：

```text
~/skillbox-repo/
```

或用户指定位置。

例如：

```text
Git Repository
      │
      ▼
skillbox.yaml
skillbox.lock
skills/
      │
      ▼
Skillbox reconcile
      │
      ▼
~/.skillbox/library
      │
      ▼
Agents
```

这样可以避免 Git 操作污染运行态。

---

# 23. Why Separate Runtime and Repository

如果直接把：

```text
Git Repo
```

当作：

```text
Runtime Library
```

可能遇到：

```text
git checkout
git merge
git conflict
git clean
git reset
```

直接影响 Agent 当前正在使用的 Skill。

因此建议采用：

```text
Repository
     ↓
Reconcile
     ↓
Runtime
```

模型。

---

# 24. Reconcile

Reconcile 是 Skillbox 核心概念之一。

定义：

> 将 Manifest / Lockfile 描述的 Desired State 转换为当前机器的 Runtime State。

例如：

```text
skillbox.yaml
+
skillbox.lock
+
skills/
        ↓
    Reconcile
        ↓
Runtime Library
        ↓
Agent Links
```

命令：

```bash
skillbox install
```

本质上执行：

```text
Resolve
Download
Verify
Materialize
Link
```

---

# 25. Reconcile Algorithm

基本流程：

```text
Read Manifest
↓
Read Lockfile
↓
Validate
↓
Resolve Sources
↓
Download Missing Managed Skills
↓
Verify Integrity
↓
Materialize Local/Forked/Vendored Skills
↓
Update Runtime Library
↓
Detect Agents
↓
Apply Agent Assignments
↓
Clean Stale Links
↓
Return Result
```

---

# 26. Agent Adapters

目录：

```text
packages/core/src/agents/adapters/
│
├── claude.ts
├── codex.ts
├── cursor.ts
├── gemini.ts
└── opencode.ts
```

Adapter 只负责：

```text
发现 Agent

定位 Skill 目录

读取 Agent 当前 Skills

创建 Link

删除 Link

处理 Agent 特殊规则
```

不负责：

```text
Marketplace

Git

Version

Security
```

---

# 27. Agent Capability Model

不是所有 Agent 能力都完全一样。

可以定义：

```ts
interface AgentCapabilities {
  supportsGlobalSkills: boolean

  supportsProjectSkills: boolean

  supportsSymlinks: boolean

  supportsNestedSkillDirectories: boolean

  requiresRestartAfterChange: boolean
}
```

这样 UI 可以基于能力展示选项。

---

# 28. Agent Detection

检测顺序：

```text
Known Config Path
↓
Known Executable
↓
Config File
↓
Environment
```

Detection Result：

```ts
interface AgentDetectionResult {
  detected: boolean

  version?: string

  executable?: string

  skillDirectories: string[]

  confidence: 'high' | 'medium' | 'low'
}
```

---

# 29. Avoid Hardcoded User Paths

禁止：

```ts
const path = `/Users/${username}/.claude/skills`
```

应该使用：

```ts
os.homedir()
path.join()
```

并由 Adapter 负责。

---

# 30. Registry Providers

第一阶段建议：

```text
GitHubProvider

SkillsShProvider

LocalProvider
```

未来：

```text
GitProvider

GitLabProvider

PrivateRegistryProvider
```

---

# 31. Provider Resolution

例如用户输入：

```bash
skillbox add vercel-labs/agent-skills@react-best-practices
```

解析为：

```text
SkillSource
↓
Provider Registry
↓
GitHubProvider
↓
ResolvedSkill
```

或者：

```bash
skillbox add ./skills/my-skill
```

解析：

```text
LocalProvider
```

---

# 32. ResolvedSkill

```ts
interface ResolvedSkill {
  id: string

  name: string

  source: SkillSource

  revision: string

  integrity: string

  files: SkillFileManifest[]

  metadata: SkillMetadata
}
```

所有 Provider 最终统一返回该模型。

---

# 33. Downloaded Skill

```ts
interface DownloadedSkill {
  resolved: ResolvedSkill

  tempPath: string

  fileCount: number

  size: number
}
```

下载过程必须先进入：

```text
tmp/
```

而不是直接进入 Runtime。

---

# 34. Install Transaction

安装应采用事务式流程：

```text
Resolve
↓
Download to Temp
↓
Validate Structure
↓
Security Scan
↓
Integrity Check
↓
Move to Runtime
↓
Write Manifest
↓
Write Lockfile
↓
Link Agents
```

如果中间失败：

```text
Rollback
```

避免部分安装。

---

# 35. Filesystem Layer

文件操作集中：

```text
filesystem/
```

而不是各 Service 自己：

```ts
fs.copyFile()
fs.rm()
fs.symlink()
```

统一抽象可以处理：

```text
Windows
macOS
Linux
```

差异。

---

# 36. Link Strategy

定义：

```ts
type LinkStrategy =
  | 'auto'
  | 'symlink'
  | 'junction'
  | 'copy'
```

默认：

```text
auto
```

策略：

### macOS

优先：

```text
symlink
```

### Linux

优先：

```text
symlink
```

### Windows

优先：

```text
junction
```

必要时：

```text
symlink
```

Fallback：

```text
copy
```

---

# 37. Copy Mode Problem

Copy 模式最大问题：

```text
Runtime Changes
≠
Agent Directory
```

因此 Copy 模式必须维护：

```text
sync metadata
```

并支持：

```text
reconcile
```

不要假装 Copy 和 Symlink 完全相同。

---

# 38. Link Metadata

运行态可以维护：

```text
~/.skillbox/state/links.json
```

例如：

```json
{
  "claude": {
    "react-best-practices": {
      "strategy": "symlink",
      "source": "/Users/user/.skillbox/library/managed/react-best-practices",
      "target": "/Users/user/.claude/skills/react-best-practices"
    }
  }
}
```

该文件：

> 不进入 Git。

---

# 39. Git Repository Structure

推荐用户 Repository：

```text
my-agent-skills/
│
├── skillbox.yaml
├── skillbox.lock
├── .skillboxignore
├── .gitignore
│
├── skills/
│   │
│   ├── local/
│   │   └── my-code-review/
│   │
│   ├── forked/
│   │   └── react-best-practices/
│   │
│   └── vendored/
│       └── private-skill/
│
└── README.md
```

也可以简化为：

```text
skills/<skill-name>
```

而由 Manifest 决定 Mode。

第一版建议：

> 使用平坦 `skills/<name>`，避免目录结构泄漏内部状态。

即：

```text
skills/
├── my-code-review/
├── react-best-practices/
└── backend-helper/
```

Mode 全部存在：

```text
skillbox.yaml
skillbox.lock
```

中。

---

# 40. Git Engine

Git Engine 不应该自行实现 Git object model。

优先调用：

```bash
git
```

原因：

- 稳定
- 用户已有凭证
- SSH 支持成熟
- GitHub Credential Manager 支持成熟
- Keychain 支持成熟
- Windows/macOS/Linux 行为一致

当 Repository 由 Skillbox GitHub Connect 管理时，系统 Git 可接收 GitHub App user access token 作为临时 HTTPS credential。凭证只存在于子进程调用期间，不拼接进参数、remote URL 或持久化 Git config。

Node 层负责：

```text
spawn
parse output
error mapping
```

---

# 41. Git Implementation

建议统一封装：

```ts
interface GitClient {
  exec(
    args: string[],
    options?: GitExecOptions
  ): Promise<GitExecResult>
}
```

Core 业务层不要直接：

```ts
spawn('git', ...)
```

---

# 42. Git Sync Model

`skillbox sync` 不等于简单：

```text
git pull && git push
```

推荐流程：

```text
Validate Repository
↓
Detect Local Skill Changes
↓
Update Manifest / Lockfile
↓
Secret Scan
↓
Git Fetch
↓
Determine Divergence
↓
Pull / Merge
↓
Reconcile Skill Conflicts
↓
Commit
↓
Push
↓
Reconcile Runtime
```

---

# 43. Git Conflict Types

需要区分：

```text
Git-level Conflict
```

和：

```text
Skill-level Conflict
```

Git-level：

```text
skillbox.yaml conflict
skillbox.lock conflict
SKILL.md conflict
```

Skill-level：

```text
Forked local version
+
New upstream version
```

两者不能混为一谈。

---

# 44. Forked Skill Model

Forked Skill 必须保存：

```text
Base Revision
Local Content
Upstream Source
```

例如：

```ts
interface SkillUpstream {
  source: SkillSource

  baseRevision: string

  latestRevision?: string
}
```

Base Revision 是 3-way Merge 的关键。

---

# 45. 3-way Merge

概念：

```text
             Base
            /    \
           /      \
       Local      Upstream
           \      /
            \    /
             Merge
```

输入：

```text
Base
Local
Upstream
```

输出：

```text
Merged
Conflicts[]
```

---

# 46. Merge Strategy

第一版可以先针对纯文本文件使用 Git：

```bash
git merge-file
```

或者实现通用 3-way text merge。

对于：

```text
SKILL.md
Markdown
JSON
YAML
TXT
```

使用 Text Merge。

对于二进制：

```text
Image
PDF
ZIP
```

不自动 Merge。

要求用户：

```text
Keep Local
Use Upstream
```

---

# 47. Security Architecture

安全分两类：

```text
Third-party Skill Scan
```

和：

```text
Secret Scan
```

---

# 48. Skill Security Scanner

安装前扫描：

```text
scripts/
executables
shell commands
filesystem access
network patterns
credential references
```

输出：

```ts
interface SecurityReport {
  risk: 'low' | 'medium' | 'high' | 'critical'

  findings: SecurityFinding[]

  scanners: ScannerResult[]
}
```

---

# 49. Security Finding

```ts
interface SecurityFinding {
  ruleId: string

  severity:
    | 'info'
    | 'low'
    | 'medium'
    | 'high'
    | 'critical'

  file: string

  line?: number

  message: string
}
```

---

# 50. Secret Scanner

Git Push 前扫描：

```text
skills/
skillbox.yaml
other tracked files
```

优先只扫描：

```text
即将 commit / push 的 changed files
```

避免每次全仓扫描。

---

# 51. Secret Policy

策略：

```text
Critical / High confidence
→ Block

Medium
→ Warning

Low
→ Info
```

用户显式 override：

```text
Ignore once
Ignore rule
Ignore path
```

---

# 52. Event System

为了同时支持：

```text
CLI progress
TUI progress
Web progress
```

Core 推荐提供 Event Bus。

例如：

```ts
type SkillboxEvent =
  | SkillDownloadStartedEvent
  | SkillDownloadProgressEvent
  | SkillInstalledEvent
  | GitSyncStartedEvent
  | GitSyncCompletedEvent
  | SecurityFindingEvent
```

UI 可以订阅。

---

# 53. Why Events

例如：

```text
skillbox install xxx
```

Core 不应该直接：

```text
console.log("Downloading...")
```

而是：

```ts
emit({
  type: 'skill.download.started',
  skillId
})
```

CLI：

```text
Downloading...
```

Web：

```text
Progress Bar
```

TUI：

```text
Spinner
```

---

# 54. Error Model

禁止 Core 到处 throw：

```text
"Something went wrong"
```

统一 Error：

```ts
class SkillboxError extends Error {
  code: string

  cause?: Error

  context?: Record<string, unknown>

  recoverable: boolean
}
```

例如：

```text
SKILL_NOT_FOUND

AGENT_NOT_DETECTED

GIT_NOT_INSTALLED

GIT_CONFLICT

INTEGRITY_MISMATCH

SECURITY_BLOCKED

SECRET_DETECTED

NETWORK_ERROR
```

---

# 55. CLI Architecture

目录：

```text
packages/cli/
│
├── src/
│   ├── commands/
│   │   ├── add.ts
│   │   ├── remove.ts
│   │   ├── list.ts
│   │   ├── update.ts
│   │   ├── sync.ts
│   │   ├── agents.ts
│   │   └── web.ts
│   │
│   ├── output/
│   ├── prompts/
│   └── index.ts
```

CLI 只负责：

```text
Parse Arguments
↓
Call Core
↓
Render Result
```

---

# 56. CLI Framework

可选择：

```text
Commander
Cac
Yargs
Clipanion
```

推荐：

```text
Commander
```

或：

```text
Cac
```

第一版优先简单稳定。

---

# 57. Interactive CLI / TUI

建议分两个阶段。

## Phase 1

使用：

```text
@clack/prompts
```

做 Interactive CLI。

优点：

- 实现快
- 操作直观
- 不需要维护复杂 Terminal Layout

---

## Phase 2

如果需要真正 Fullscreen TUI：

```text
Ink
```

或者：

```text
OpenTUI
```

再升级。

因此：

> V0.1 不强制实现复杂 Fullscreen TUI。

---

# 58. Web Architecture

Web 建议：

```text
CLI
 ↓
skillbox web
 ↓
Local HTTP Server
 ↓
Core Services
 ↓
JSON API / RPC
 ↓
Web Frontend
```

---

# 59. Local Web Server

推荐：

```text
Hono
```

或：

```text
Fastify
```

如果强调：

```text
轻量
TypeScript
易嵌入
```

推荐：

```text
Hono
```

---

# 60. Web Server Binding

默认：

```text
127.0.0.1
```

例如：

```text
http://127.0.0.1:43821
```

禁止默认：

```text
0.0.0.0
```

---

# 61. Web API

示例：

```text
GET /api/skills

GET /api/skills/:id

POST /api/skills/install

POST /api/skills/:id/update

DELETE /api/skills/:id

GET /api/agents

POST /api/agents/:id/skills/:skillId/enable

POST /api/git/sync

GET /api/git/status
```

内部仍然：

```text
Route
↓
Core Service
```

---

# 62. Web Frontend

推荐：

```text
React
Vite
TypeScript
```

状态层：

```text
TanStack Query
```

路由：

```text
TanStack Router
```

UI：

```text
shadcn/ui
```

图标：

```text
Lucide
```

---

# 63. Web App Structure

```text
apps/web/
│
├── src/
│   ├── pages/
│   │   ├── library/
│   │   ├── explore/
│   │   ├── updates/
│   │   ├── agents/
│   │   ├── git/
│   │   └── settings/
│   │
│   ├── components/
│   ├── api/
│   ├── hooks/
│   └── app.tsx
```

---

# 64. No Business Logic in Frontend

Frontend 不能决定：

```text
Managed → Forked
```

这种状态转换。

例如用户点击 Edit：

```text
Web
↓
POST /api/skills/:id/fork
↓
Core
↓
Validate State
↓
Fork
```

UI 只展示结果。

---

# 65. Web Distribution

由于 Skillbox 是 NPM 包：

```text
Web Frontend Build
```

需要在 npm publish 前构建为：

```text
static assets
```

然后打包到：

```text
@skillbox/web-server
```

或主 Package。

运行：

```bash
npx skillbox web
```

不需要：

```text
npm install frontend dependencies
```

---

# 66. NPM Package Layout

最终用户看到：

```text
skillbox
```

一个 Package 即可。

内部可以是 monorepo 多 package。

Publish 时可选择：

```text
@skillbox/core
@skillbox/cli
```

独立发布。

或者初期：

```text
skillbox
```

单包发布。

第一版建议：

> Monorepo 内部分包，但公网只发布 `skillbox`。

减少版本管理复杂度。

---

# 67. Binary Entry

`package.json`：

```json
{
  "name": "skillbox",
  "bin": {
    "skillbox": "./bin/skillbox.mjs"
  }
}
```

用户：

```bash
npx skillbox
```

或：

```bash
npm install -g skillbox
```

---

# 68. Config Architecture

全局配置：

```text
~/.skillbox/config.json
```

保存：

```text
Repository Path

Default Branch

Link Strategy

Web Port

Browser Open

Security Preferences

Agent Overrides

GitHub connection metadata
```

允许保存的 GitHub metadata：

```json
{
  "github": {
    "connected": true,
    "login": "user",
    "provider": "github-app",
    "repository": "user/skillbox-skills"
  }
}
```

禁止保存 access token、refresh token、device code 或临时 Git credential。

---

# 69. Repository Config

项目级：

```text
skillbox.yaml
```

保存：

```text
Skills

Agents Assignment

Sources

Modes

Project Configuration
```

原则：

```text
Global Config
=
Machine-specific

skillbox.yaml
=
Portable
```

---

# 70. Never Sync Machine-specific Paths

以下内容禁止进入：

```text
skillbox.yaml
skillbox.lock
```

例如：

```text
C:\Users\xxx

/Users/xxx

/home/xxx
```

绝对路径只允许存在：

```text
~/.skillbox/config.json
~/.skillbox/state/
```

---

# 71. Lockfile Integrity

Managed Skill 下载后：

```text
files
↓
canonical normalization
↓
SHA-256
```

写入：

```text
skillbox.lock
```

恢复时：

```text
Download
↓
Compute Hash
↓
Compare Lockfile
```

不一致：

```text
INTEGRITY_MISMATCH
```

默认停止安装。

---

# 72. Hash Strategy

必须提前规定：

> Integrity 是对什么计算。

建议：

对 Skill 文件树进行稳定排序：

```text
relative path
+
file content
+
file mode if relevant
```

再计算 Hash。

避免 ZIP metadata / timestamp 导致 Hash 不稳定。

---

# 73. Cache

Managed Skills：

```text
~/.skillbox/cache/
```

建议按：

```text
source hash
revision
integrity
```

缓存。

例如：

```text
cache/
└── github/
    └── vercel-labs-agent-skills/
        └── 07a81df/
```

---

# 74. Cache Is Disposable

Cache 必须：

> 可以随时删除。

执行：

```bash
skillbox cache clean
```

不能导致：

```text
Local
Forked
Vendored
```

Skill 丢失。

---

# 75. Temporary Directory

下载安装：

```text
~/.skillbox/tmp/
```

所有 remote Skill 先进入 tmp。

只有：

```text
Validation passed
Security passed
Integrity passed
```

才进入 Library。

---

# 76. Logging

日志：

```text
~/.skillbox/logs/
```

默认不记录：

```text
Secret values
Full environment
Tokens
Credentials
```

日志应该支持：

```bash
skillbox --debug
```

---

# 77. Concurrency

需要防止：

```text
两个 skillbox sync 同时运行
```

导致 Repository / Lockfile 损坏。

建议：

```text
~/.skillbox/state/skillbox.lock
```

运行锁。

注意该 lock 和：

```text
skillbox.lock
```

不是同一个概念。

运行锁建议命名：

```text
runtime.lock
```

避免混淆。

---

# 78. Atomic Writes

以下文件必须：

```text
atomic write
```

处理：

```text
skillbox.yaml

skillbox.lock

config.json

state files
```

流程：

```text
write temp
↓
fsync where appropriate
↓
rename
```

避免进程中断导致文件损坏。

---

# 79. Backup Before Destructive Operation

以下行为：

```text
Merge
Vendor
Remove modified Skill
Restore
Overwrite
```

可以在：

```text
~/.skillbox/backups/
```

生成短期备份。

但长期版本历史依赖：

```text
Git
```

---

# 80. Platform Layer

建议所有平台差异集中到：

```text
platform/
```

例如：

```text
platform/
├── windows.ts
├── macos.ts
└── linux.ts
```

处理：

```text
links
permissions
shell
open browser
path behavior
```

---

# 81. Browser Open

`skillbox web`：

```text
macOS:
open

Windows:
start

Linux:
xdg-open
```

不要在业务逻辑里判断。

提供：

```ts
platform.openUrl(url)
```

---

# 82. Windows Considerations

重点测试：

```text
NTFS Junction

Symlink Permission

Long Paths

PowerShell

Git for Windows

Path Case

Drive Letter

Antivirus locking files
```

特别注意：

```text
C:\Users\User
```

和：

```text
c:\users\user
```

路径标准化。

---

# 83. macOS Considerations

重点：

```text
symlink

case-insensitive filesystem

Gatekeeper unrelated executable warnings

Keychain Git auth
```

---

# 84. Linux Considerations

重点：

```text
permissions

symlink

XDG paths

headless mode

no browser available
```

TUI / CLI 必须在 Linux Server 上完整工作。

---

# 85. Tests

测试分层：

```text
Unit

Integration

Adapter

Filesystem

Git

End-to-End
```

---

# 86. Unit Tests

覆盖：

```text
Manifest parsing

Lock resolution

State transition

Source parsing

Integrity hash

Security rules
```

---

# 87. Integration Tests

覆盖：

```text
Install Skill

Fork Skill

Vendor Skill

Update Skill

Git Sync

Reconcile

Agent Link
```

---

# 88. Agent Adapter Tests

Adapter 测试不要依赖用户真实环境。

使用：

```text
temporary HOME
fixture filesystem
mock executable
```

例如：

```text
/tmp/test-home/.claude/skills
```

---

# 89. Git Tests

测试使用临时 Repository：

```text
remote.git
↓
device-a
device-b
```

模拟：

```text
clone
push
pull
diverge
conflict
```

这是 Multi-device Sync 最重要的测试。

---

# 90. E2E

最重要的 E2E：

```text
Device A

Install Skill
Create Local Skill
Fork Skill
Push

↓

Device B

Clone
Install
Detect Agent
Restore

↓

Verify Environment
```

---

# 91. State Transition Tests

必须覆盖：

```text
Managed → Forked

Managed → Vendored

Managed → Updated

Forked → Merged

Forked → Vendored

Local → Removed
```

禁止出现非法转换。

---

# 92. Suggested Dependency Policy

Core 尽量减少依赖。

优先：

```text
Node built-ins
```

对于核心数据：

```text
zod
```

可用于 Schema Validation。

Git：

```text
system git
```

不要一开始引入复杂 Git JS implementation。

---

# 93. Versioning

Skillbox 本身使用：

```text
Semantic Versioning
```

Manifest / Lockfile Schema 独立版本。

例如：

```yaml
version: 1
```

```yaml
lockfileVersion: 1
```

CLI 升级不一定意味着 Schema 升级。

---

# 94. Migration

Core 必须保留：

```text
schema migration
```

机制。

例如：

```text
Manifest v1
↓
Skillbox Upgrade
↓
Manifest v2
```

不要直接假设所有用户永远是最新版。

---

# 95. Backward Compatibility

至少保证：

```text
同一个 Major Version
```

内可以读取旧 Manifest。

如果需要修改：

```text
skillbox migrate
```

提供显式迁移。

---

# 96. Plugin Architecture

第一版不需要做真正 Plugin System。

但是接口：

```text
AgentAdapter

RegistryProvider

SecurityScanner
```

应设计成可注册。

例如：

```ts
skillbox.registerAgentAdapter(...)
```

未来再开放第三方 Plugin。

---

# 97. Future Extension

长期：

```text
@skillbox/core
      │
      ├── Skills
      ├── MCP
      ├── Rules
      ├── Prompts
      └── Hooks
```

但当前不要在代码里大量提前抽象：

```text
AgentResourceManager<T>
```

避免过度设计。

第一版：

> 抽象到支持 Skills 足够即可。

---

# 98. Suggested Initial Dependency Graph

```text
                 domain
                   ▲
                   │
          ┌────────┴────────┐
          │                 │
      filesystem          config
          ▲                 ▲
          │                 │
          └────────┬────────┘
                   │
                skills
             ▲     │     ▲
             │     │     │
          agents registry git
             ▲     ▲     ▲
             └─────┼─────┘
                   │
               services
                   ▲
          ┌────────┼────────┐
          │        │        │
         CLI      TUI      Web
```

尽量保持依赖单向。

---

# 99. Forbidden Dependency

例如：

```text
core
↓
cli
```

禁止。

```text
core
↓
web
```

禁止。

```text
agent adapter
↓
React
```

禁止。

正确：

```text
CLI
↓
Core
```

---

# 100. Initial Development Order

推荐实际开发顺序：

## Phase 1

```text
Domain Model

Filesystem Layer

Manifest

Lockfile
```

---

## Phase 2

```text
Agent Adapter Interface

Claude Adapter

Codex Adapter

Agent Detection
```

---

## Phase 3

```text
Canonical Library

Import

Link / Unlink

Reconcile
```

到这里就已经能实现：

```text
npx skillbox
```

管理本地 Skills。

---

## Phase 4

```text
CLI

Interactive CLI
```

---

## Phase 5

```text
Local Web Server

Web UI
```

---

## Phase 6

```text
Git Engine

Repository Service

GitHub Integration

Device Flow

Credential Store

Git HTTPS Credential Bridge

Git Sync

Multi-device Restore
```

---

## Phase 7

```text
Registry Providers

Remote Install

Update
```

---

## Phase 8

```text
Managed

Forked

Vendored

Diff

3-way Merge
```

---

## Phase 9

```text
Security Scan

Secret Scan
```

部分 Secret Scan 可以为了 Git 安全提前到 Phase 6。

---

# 101. MVP Architecture Boundary

V0.1 最小架构：

```text
CLI / Interactive CLI / Web
             │
             ▼
           Core
             │
       ┌─────┼─────┐
       │     │     │
     Skill Agent Filesystem
       │     │
       │     ▼
       │  Adapters
       │
       ▼
Manifest + Lockfile
```

暂时不需要：

```text
Marketplace

Fork Merge

Complex Plugin System

Cloud Backend
```

---

# 102. V0.2 Architecture Boundary

加入：

```text
Git Engine

Repository

Secret Scan

Multi-device Reconcile
```

形成：

```text
Git Repository
      │
      ▼
Manifest + Lock
      │
      ▼
Reconcile
      │
      ▼
Runtime Library
      │
      ▼
Agents
```

---

# 103. V0.3 Architecture Boundary

加入：

```text
Registry Providers
      │
      ▼
Remote Skills
      │
      ▼
Resolve
Download
Scan
Verify
      │
      ▼
Runtime
```

---

# 104. V0.4 Architecture Boundary

加入：

```text
           Upstream
              │
              ▼
             Base
              │
        ┌─────┴─────┐
        ▼           ▼
      Local       Latest
        │           │
        └─────┬─────┘
              ▼
            Merge
```

正式完成完整 Skill Lifecycle。

---

# 105. Architecture Decision Summary

项目启动前建议锁定以下架构决策。

## ADR-001

Core 与 UI 完全解耦。

---

## ADR-002

所有 CLI / TUI / Web 共用：

```text
@skillbox/core
```

---

## ADR-003

Agent 差异通过：

```text
AgentAdapter
```

解决。

---

## ADR-004

Marketplace / Source 差异通过：

```text
RegistryProvider
```

解决。

---

## ADR-005

使用系统 Git，而不是重新实现 Git。

---

## ADR-006

Runtime Library 与 Git Repository 分离。

---

## ADR-007

使用：

```text
Desired State
+
Resolved State
+
Runtime State
```

三层模型。

即：

```text
skillbox.yaml
↓
skillbox.lock
↓
Runtime Library
```

---

## ADR-008

第三方未修改 Skill：

```text
Managed
```

不完整进入 Git。

---

## ADR-009

用户修改第三方 Skill：

```text
Managed → Forked
```

开始完整进入 Git。

---

## ADR-010

用户完全接管第三方 Skill：

```text
Managed / Forked → Vendored
```

停止跟踪 Upstream。

---

## ADR-011

所有安装采用：

```text
Resolve
Download
Validate
Scan
Verify
Materialize
```

事务式流程。

---

## ADR-012

Git Push 前进行 Secret Scan。

---

## ADR-013

Web 默认只监听：

```text
127.0.0.1
```

---

## ADR-014

Machine-specific State 不进入 Git。

---

## ADR-015

优先保证：

```text
macOS
Windows
Linux
```

一致行为。

---

## ADR-016

Git 是同步协议，GitHub 是默认云端 Provider。GitHub Integration 与 Git Engine 分层，二者不得合并。

---

## ADR-017

0.2 默认使用支持 Device Flow 的 GitHub App。公开 CLI 不分发 Client Secret。

---

## ADR-018

GitHub access token 和 refresh token 只存入 OS Credential Store。配置文件和 Git remote 不保存 token。

---

## ADR-019

GitHub Private Repository 是默认同步存储；Generic Git 是完整支持的高级模式；Gist 不进入 0.2 默认路径。

---

# 106. Final Architecture Model

最终推荐模型：

```text
                         ┌──────────────┐
                         │   Registry   │
                         │ GitHub / ... │
                         └──────┬───────┘
                                │
                             Resolve
                                │
                                ▼
                         ┌──────────────┐
                         │ Skillbox Core│
                         └──────┬───────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
        Git Repository     Runtime Library       Agent Layer
            │                   │                   │
    skillbox.yaml               │          ┌────────┼────────┐
    skillbox.lock               │          ▼        ▼        ▼
    skills/                     │       Claude    Codex    Cursor
            │                   │
            └─────────Reconcile─┘

                                ▲
                                │
                  ┌─────────────┼─────────────┐
                  │             │             │
                  ▼             ▼             ▼
                 CLI           TUI           Web
```

核心思想：

> **Repository 描述环境，Runtime 执行环境，Adapter 连接 Agent，Core 统一所有规则。**

云端同步的核心边界是：

> **GitHub Integration 管身份和云端 Repository，Git Engine 管本地版本控制和数据传输。**

Skillbox 不应该成为：

```text
一个会帮用户复制文件的 GUI
```

而应该成为：

> **一个真正理解 Agent Skills 生命周期、依赖关系、来源、版本、状态和分发关系的 Package Manager。**

---

# 107. Architectural North Star

所有新功能都应该问三个问题：

```text
1. 这项逻辑是否应该进入 Core？

2. 这项功能是否会破坏跨 Agent / 跨平台抽象？

3. 这项状态是否可以被 Repository 完整描述和恢复？
```

如果答案合理，才应该加入系统。

最终目标：

```text
Repository
+
Skillbox
=
Reproducible Agent Skills Environment
```
