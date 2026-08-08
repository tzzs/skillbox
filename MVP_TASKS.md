# Skillbox MVP Development Tasks

> File: `MVP_TASKS.md`
> Status: Draft
> Version: 0.2
> Last Updated: 2026-08-09

---

# 1. Purpose

本文档用于将 Skillbox 的产品和架构设计拆解为：

```text
Milestone
↓
Epic
↓
Task
↓
Definition of Done
```

目标是：

> 可以直接将任务交给 Coding Agent 按阶段实现，而不需要重新理解整个产品需求。

相关文档：

```text
PRD.md
ARCHITECTURE.md
SKILLBOX_SPEC.md
MVP_TASKS.md
```

其中：

```text
PRD.md
```

定义：

> 做什么。

```text
ARCHITECTURE.md
```

定义：

> 怎么组织代码。

```text
SKILLBOX_SPEC.md
```

定义：

> Manifest、Lockfile 和 Skill 生命周期协议。

本文档定义：

> 以什么顺序实现。

---

# 2. MVP Strategy

Skillbox 不应该从第一天就实现：

```text
Marketplace
Fork
3-way Merge
Security Scanner
复杂 TUI
MCP
Rules
Profiles
```

第一阶段必须优先验证最核心的价值：

> **用户能否通过一个工具统一管理多个 Agent 的 Skills。**

因此开发顺序：

```text
M0 — Project Foundation

M1 — Core Domain + Filesystem

M2 — Manifest + Lockfile

M3 — Agent Detection

M4 — Canonical Skill Library

M5 — Local Skill Management

M6 — CLI

M7 — Interactive CLI

M8 — Web UI

M9 — GitHub Connect + Git Sync

M10 — Remote Skills

M11 — Update Management

M12 — Fork / Vendor

M13 — Diff / Merge

M14 — Security
```

其中真正 MVP：

```text
M0 → M8
```

完成即可发布：

```text
0.1.0
```

Git Sync 完成后：

```text
0.2.0
```

Marketplace / Remote Install：

```text
0.3.0
```

完整生命周期：

```text
0.4.0
```

---

# 3. Priority Definitions

统一优先级：

## P0

阻止 MVP 发布的任务。

必须完成。

---

## P1

重要，但可以在第一个可用版本后完成。

---

## P2

增强体验。

可以延后。

---

## P3

长期能力。

不属于当前 MVP。

---

# 4. Milestone Overview

| Milestone | Scope | Target Version |
|---|---|---|
| M0 | Repository / Tooling | Internal |
| M1 | Core Domain | Internal |
| M2 | Manifest / Lockfile | Internal |
| M3 | Agent Detection | Internal |
| M4 | Canonical Library | Internal |
| M5 | Local Skill Management | Internal |
| M6 | CLI | 0.1-alpha |
| M7 | Interactive CLI | 0.1-beta |
| M8 | Web UI | 0.1.0 |
| M9 | GitHub Connect + Git Sync | 0.2.0 |
| M10 | Remote Skills | 0.3.0 |
| M11 | Updates | 0.3.x |
| M12 | Fork / Vendor | 0.4-alpha |
| M13 | Diff / Merge | 0.4.0 |
| M14 | Security | 0.4.x |

---

# 5. M0 — Project Foundation

## Goal

建立稳定 Monorepo、CI、代码规范和 Package 边界。

---

## M0.1 Initialize Monorepo

**Priority:** P0

创建：

```text
skillbox/
├── apps/
├── packages/
├── bin/
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.json
```

使用：

```text
TypeScript
Node.js
pnpm
```

### Definition of Done

执行：

```bash
pnpm install
pnpm build
pnpm test
```

全部成功。

---

# 6. M0.2 Create Packages

创建：

```text
packages/core
packages/cli
packages/shared
packages/testing
apps/web
```

暂时可以不创建：

```text
packages/tui
```

Interactive CLI 第一版可以直接放在 CLI Package。

### Definition of Done

各 Package：

```text
可单独 build
TypeScript path 正确
无循环依赖
```

---

# 7. M0.3 Configure TypeScript

启用：

```text
strict
noUncheckedIndexedAccess
exactOptionalPropertyTypes
```

根据实际开发体验可调整。

### Definition of Done

所有 Package：

```bash
pnpm typecheck
```

通过。

---

# 8. M0.4 Code Quality

配置：

```text
ESLint
Prettier
```

建议：

```text
Vitest
```

用于测试。

### Definition of Done

存在：

```bash
pnpm lint
pnpm format
pnpm test
```

---

# 9. M0.5 CI

GitHub Actions：

```text
Install
Lint
Typecheck
Test
Build
```

支持：

```text
Ubuntu
Windows
macOS
```

至少 Build + Test 应覆盖三平台。

### Definition of Done

Pull Request 自动执行 CI。

---

# 10. M0.6 CLI Binary Skeleton

创建：

```text
bin/skillbox.mjs
```

Package：

```json
{
  "bin": {
    "skillbox": "./bin/skillbox.mjs"
  }
}
```

执行：

```bash
pnpm skillbox --version
```

返回版本。

### Definition of Done

本地：

```bash
pnpm exec skillbox --help
```

正常运行。

---

# 11. M1 — Core Domain

## Goal

建立所有后续模块共享的数据模型。

---

# 12. M1.1 Skill Domain Types

实现：

```ts
Skill
SkillMode
SkillStatus
SkillSource
SkillUpstream
```

其中：

```ts
type SkillMode =
  | 'managed'
  | 'forked'
  | 'local'
  | 'vendored'
```

Status：

```ts
type SkillStatus =
  | 'ready'
  | 'modified'
  | 'outdated'
  | 'conflict'
  | 'missing'
  | 'broken'
```

### Definition of Done

Domain 类型：

```text
不依赖 CLI
不依赖 React
不依赖 Node UI
```

---

# 13. M1.2 Agent Domain

实现：

```ts
Agent
AgentCapabilities
AgentDetectionResult
AgentInstalledSkill
```

### Definition of Done

支持：

```text
detected
version
skill directories
capabilities
```

---

# 14. M1.3 Error Model

实现：

```ts
SkillboxError
```

标准错误码：

```text
SKILL_NOT_FOUND
INVALID_SKILL
AGENT_NOT_DETECTED
GIT_NOT_FOUND
INTEGRITY_MISMATCH
INVALID_MANIFEST
INVALID_LOCKFILE
UNSAFE_PATH
UNSAFE_SYMLINK
```

### Definition of Done

Core 不再随意 throw 普通字符串。

---

# 15. M1.4 Result Model

需要时定义：

```ts
OperationResult<T>
```

或者统一使用：

```text
typed error + exception
```

二选一。

第一版建议：

> Core 使用 Typed Error，不额外发明复杂 Result Monad。

---

# 16. M2 — Filesystem Layer

## Goal

建立跨平台安全文件操作基础。

---

# 17. M2.1 FilesystemService

实现：

```ts
exists()
readFile()
writeFile()
copy()
move()
remove()
mkdir()
readDir()
stat()
```

内部使用：

```text
node:fs/promises
```

### Definition of Done

其他 Core Service 不直接大量调用 fs。

---

# 18. M2.2 Atomic Write

实现：

```ts
atomicWriteFile()
```

用于：

```text
skillbox.yaml
skillbox.lock
config.json
runtime state
```

流程：

```text
write temp
↓
rename
```

### Definition of Done

测试模拟中途错误不会破坏旧文件。

---

# 19. M2.3 Path Safety

实现：

```ts
validateRelativePath()
resolveInsideRoot()
```

必须拒绝：

```text
../../
absolute path
Windows drive escape
```

### Definition of Done

以下必须失败：

```text
../../../etc/passwd
C:\Windows\System32
/Users/foo
```

当 API 只允许 Repository Relative Path 时。

---

# 20. M2.4 Directory Scanner

实现：

```ts
scanSkillDirectory()
```

返回：

```text
files
directories
symlinks
size
```

### Definition of Done

能够扫描：

```text
SKILL.md
scripts/
references/
assets/
```

---

# 21. M2.5 Skill Validator

检查：

```text
SKILL.md exists
no path traversal
no unsafe special file
```

### Definition of Done

非法 Skill 返回：

```text
INVALID_SKILL
```

---

# 22. M2.6 Symlink Safety

远程/导入 Skill 中遇到 symlink：

解析 Target。

如果 Target 超出 Skill Root：

```text
UNSAFE_SYMLINK
```

### Definition of Done

安全内部 Symlink 可以保留。

外部 Symlink 被阻止。

---

# 23. M2.7 Link Strategy

实现：

```ts
type LinkStrategy =
  | 'auto'
  | 'symlink'
  | 'junction'
  | 'copy'
```

### Platform

macOS：

```text
symlink
```

Linux：

```text
symlink
```

Windows：

```text
junction / symlink
```

Fallback：

```text
copy
```

### Definition of Done

三平台 Integration Test 通过。

---

# 24. M3 — Manifest

## Goal

实现 `skillbox.yaml`。

---

# 25. M3.1 Manifest Schema

使用：

```text
Zod
```

或其他 schema validator。

实现：

```ts
SkillboxManifest
ManifestSkill
ManifestSettings
```

### Definition of Done

可以解析：

```yaml
version: 1
skills: {}
```

---

# 26. M3.2 Source Schema

实现：

```text
github
git
registry
local
```

虽然第一版只有：

```text
github
local
```

真正使用。

### Definition of Done

错误 Source 有明确 Validation Error。

---

# 27. M3.3 Manifest Reader

实现：

```ts
readManifest(repositoryRoot)
```

处理：

```text
not found
invalid yaml
unsupported version
schema invalid
```

---

# 28. M3.4 Manifest Writer

实现：

```ts
writeManifest()
```

要求：

```text
UTF-8
LF
2 spaces
deterministic ordering where possible
```

---

# 29. M3.5 Manifest Mutation

实现：

```ts
addSkill()
removeSkill()
updateSkill()
setAgents()
```

### Definition of Done

Mutation 后重新读取结果一致。

---

# 30. M4 — Lockfile

## Goal

实现可复现 Resolved State。

---

# 31. M4.1 Lockfile Schema

实现：

```ts
SkillboxLockfile
LockedSkill
LockedUpstream
```

支持：

```text
managed
local
```

第一阶段即可。

---

# 32. M4.2 Lockfile Reader / Writer

与 Manifest 类似。

要求：

```text
Deterministic
Machine-independent
```

### Definition of Done

同样输入连续写两次：

```text
git diff = empty
```

---

# 33. M4.3 Integrity Hash

实现 Canonical Skill Hash。

算法：

```text
scan files
↓
relative paths normalized to /
↓
sort
↓
hash each file
↓
hash canonical manifest
```

使用：

```text
SHA-256
```

格式：

```text
sha256:<hex>
```

### Definition of Done

同样文件内容：

```text
Windows
macOS
Linux
```

获得相同 Hash。

---

# 34. M4.4 .gitattributes Fixture

测试 Repository 默认生成：

```gitattributes
* text=auto eol=lf
```

确保跨平台文本一致。

---

# 35. M4.5 Local Modification Detection

实现：

```text
current integrity
vs
locked integrity
```

结果：

```text
ready
modified
```

### Definition of Done

修改 `SKILL.md` 后：

```text
status = modified
```

---

# 36. M5 — Agent Adapter Framework

## Goal

让 Core 不绑定具体 Agent。

---

# 37. M5.1 AgentAdapter Interface

实现：

```ts
interface AgentAdapter {
  id
  name
  detect()
  getSkillDirectories()
  scanSkills()
  linkSkill()
  unlinkSkill()
}
```

### Definition of Done

新 Agent 可以通过新增 Adapter 文件接入。

---

# 38. M5.2 Agent Registry

实现：

```ts
register()
get()
list()
detectAll()
```

### Definition of Done

Core 不需要：

```text
switch(agent)
```

---

# 39. M5.3 Claude Code Adapter

实现：

```text
detect Claude Code
find skills directory
scan current skills
link
unlink
```

路径必须基于实际规范实现，而不是写死用户目录。

### Definition of Done

真实环境和 Fixture 环境均测试。

---

# 40. M5.4 Codex Adapter

与 Claude 同样能力。

### Definition of Done

可以：

```text
Detect
Scan
Enable Skill
Disable Skill
```

---

# 41. M5.5 Cursor Adapter

Priority：

```text
P1
```

如果 MVP 时间紧，可以放到 0.1.1。

---

# 42. M5.6 Agent Detection Service

执行：

```ts
detectAll()
```

返回：

```text
Claude Code
Codex
Cursor
...
```

UI 能显示：

```text
Detected
Not Detected
Version
Skill Count
```

---

# 43. M5.7 External Skill Detection

扫描 Agent Skills 时区分：

```text
Skillbox-owned
External
```

不要自动删除 External Skill。

### Definition of Done

External Skill 在 Reconcile 后仍存在。

---

# 44. M6 — Canonical Library

## Goal

建立 Skillbox 自己的 Runtime Library。

---

# 45. M6.1 Skillbox Home

默认：

```text
~/.skillbox/
```

目录：

```text
library/
cache/
state/
tmp/
logs/
```

### Definition of Done

首次启动自动创建。

---

# 46. M6.2 Runtime Config

创建：

```text
~/.skillbox/config.json
```

保存：

```text
repository
linkStrategy
web config
agent path overrides
```

### Definition of Done

Machine-specific 数据不进入 Repository。

---

# 47. M6.3 Runtime Library Service

实现：

```ts
materializeSkill()
removeRuntimeSkill()
getRuntimeSkill()
listRuntimeSkills()
```

---

# 48. M6.4 Runtime State

创建：

```text
~/.skillbox/state/links.json
```

记录：

```text
Skillbox-created Agent Links
```

### Definition of Done

Reconcile 知道哪些 Link 可以安全删除。

---

# 49. M6.5 Import Existing Skill

用户可将 External Skill Import。

第一版：

> Source unknown → Local。

流程：

```text
Agent skill
↓
copy into Repository skills/
↓
Manifest add local
↓
Lock integrity
↓
Runtime materialize
↓
replace external copy with managed link
```

### Definition of Done

原 Skill 内容不丢失。

---

# 50. M6.6 Import Conflict Handling

如果：

```text
Claude/foo
Codex/foo
```

同名但内容不同：

禁止静默合并。

提示：

```text
Skill alias conflict
```

允许：

```text
Choose one
Import both with aliases
Skip
```

---

# 51. M7 — Reconcile Engine

## Goal

实现：

```text
Manifest + Lockfile
↓
Runtime
↓
Agents
```

---

# 52. M7.1 Reconcile Service

实现：

```ts
reconcile()
```

基础流程：

```text
Read Manifest
Read Lockfile
Validate
Materialize Local Skills
Verify Integrity
Detect Agents
Apply Assignments
Clean Stale Skillbox Links
```

---

# 53. M7.2 Idempotency

连续执行两次：

```bash
skillbox install
skillbox install
```

第二次：

```text
No changes
```

### Definition of Done

不重复 Copy、不重复修改 Manifest/Lock。

---

# 54. M7.3 Agent Assignment

根据：

```yaml
agents:
  - claude
  - codex
```

创建链接。

没有 Agent 配置：

遵循：

```text
defaultAgents
```

否则：

```text
none
```

---

# 55. M7.4 Disable Assignment

如果 Manifest 从：

```yaml
agents:
  - claude
  - codex
```

变成：

```yaml
agents:
  - claude
```

Reconcile 删除：

```text
Codex Skillbox-owned Link
```

但不删除 External Skill。

---

# 56. M7.5 Missing Local Skill

Manifest 指向：

```text
./skills/foo
```

但目录不存在：

```text
status = missing
```

并返回明确错误。

---

# 57. M7.6 Broken Skill

Local Skill 不包含：

```text
SKILL.md
```

标记：

```text
broken
```

---

# 58. M8 — Basic CLI

## Goal

让所有 P0 Core 能力可通过 CLI 使用。

---

# 59. M8.1 CLI Framework

推荐：

```text
Commander
```

建立：

```bash
skillbox --help
```

---

# 60. M8.2 skillbox list

输出：

```text
NAME                  MODE     STATUS

my-review             local    ready
frontend              local    modified
```

支持：

```bash
skillbox list --json
```

### Definition of Done

JSON 输出可供脚本使用。

---

# 61. M8.3 skillbox agents

输出：

```text
AGENT        STATUS       SKILLS

Claude Code  detected     12
Codex        detected      8
Cursor       not found     -
```

---

# 62. M8.4 skillbox create

```bash
skillbox create my-skill
```

生成：

```text
skills/my-skill/SKILL.md
```

添加：

```text
skillbox.yaml
skillbox.lock
```

### Definition of Done

新 Skill 立即进入 Library。

---

# 63. M8.5 skillbox remove

支持：

```bash
skillbox remove foo
```

Local Skill 默认：

```text
remove config only
```

使用：

```bash
skillbox remove foo --delete-files
```

才删除完整文件。

---

# 64. M8.6 skillbox enable

推荐比：

```text
link
```

更贴近用户语义。

例如：

```bash
skillbox enable my-skill --agent claude
```

---

# 65. M8.7 skillbox disable

```bash
skillbox disable my-skill --agent codex
```

更新 Manifest 后 Reconcile。

---

# 66. M8.8 skillbox install

语义：

```text
Restore / Reconcile current Repository
```

不是：

```text
Install npm package
```

运行：

```bash
skillbox install
```

---

# 67. M8.9 skillbox status

显示：

```text
Repository
Skills
Agents
Modified Skills
Broken Skills
```

第一版不需要 Git 状态。

---

# 68. M8.10 --json

核心只读命令支持：

```text
--json
```

至少：

```text
list
agents
status
```

方便自动化。

---

# 69. M8.11 Exit Codes

统一：

```text
0 success
1 generic failure
2 validation
3 conflict
4 security
```

具体可后续固定。

关键：

> 非交互工具必须有稳定非零 Exit Code。

---

# 70. M9 — Interactive CLI

## Goal

执行：

```bash
npx skillbox
```

即可以使用，无需记命令。

---

# 71. M9.1 Welcome

显示：

```text
Skillbox

✓ Claude Code
✓ Codex

12 skills managed
```

---

# 72. M9.2 Main Menu

```text
My Skills
Agents
Import Existing Skills
Create Skill
Open Web UI
Settings
Exit
```

---

# 73. M9.3 Prompt Framework

第一版使用：

```text
@clack/prompts
```

不做复杂 Fullscreen TUI。

---

# 74. M9.4 First-run Onboarding

第一次运行：

```text
Detect Agents
↓
Scan Existing Skills
↓
Offer Import
↓
Backup & Sync
↓
Connect GitHub or Skip
```

0.1 可以暂时：

```text
Skip
```

0.2 必须支持：

```text
Connect GitHub
↓
Device authorization
↓
Create new private repository / Select existing / Advanced Git remote
↓
Initial sync
```

---

# 75. M9.5 Import UI

支持多选：

```text
✓ react
✓ frontend-design
○ test-helper
```

---

# 76. M9.6 Skill Detail

Interactive CLI：

```text
Skill: my-code-review

Mode: Local
Status: Ready

Agents
✓ Claude
✓ Codex

Actions
> Edit
  Enable/Disable
  Remove
  Back
```

---

# 77. M10 — Local Web Server

## Goal

运行：

```bash
skillbox web
```

打开浏览器管理 Skills。

---

# 78. M10.1 Web Server Package

推荐：

```text
Hono
```

启动：

```text
127.0.0.1:43821
```

---

# 79. M10.2 Random Port Fallback

如果：

```text
43821
```

被占用：

寻找可用端口。

输出实际 URL。

---

# 80. M10.3 --port

支持：

```bash
skillbox web --port 3000
```

---

# 81. M10.4 --host

支持：

```bash
skillbox web --host 127.0.0.1
```

如果：

```text
0.0.0.0
```

必须警告：

```text
Skillbox UI will be exposed to the local network.
```

---

# 82. M10.5 Auto Open Browser

默认：

```text
true
```

支持：

```bash
skillbox web --no-open
```

---

# 83. M10.6 API Foundation

实现：

```text
GET /api/health

GET /api/skills

GET /api/skills/:id

GET /api/agents

GET /api/status
```

---

# 84. M10.7 Mutating APIs

实现：

```text
POST /api/skills

DELETE /api/skills/:id

POST /api/skills/:id/enable

POST /api/skills/:id/disable

POST /api/reconcile
```

---

# 85. M10.8 Error Response

统一：

```json
{
  "error": {
    "code": "SKILL_NOT_FOUND",
    "message": "...",
    "recoverable": true
  }
}
```

---

# 86. M11 — Web Frontend

## Goal

完成 0.1 正式版 UI。

---

# 87. M11.1 Web Stack

建议：

```text
React
Vite
TypeScript
TanStack Query
shadcn/ui
Lucide
```

---

# 88. M11.2 App Shell

导航：

```text
Library
Agents
Settings
```

第一版暂时没有：

```text
Explore
Updates
Git
```

---

# 89. M11.3 Library Page

显示：

```text
Name
Mode
Status
Agents
```

支持：

```text
Search
Filter
```

---

# 90. M11.4 Skill Detail

显示：

```text
Name
Path
Mode
Integrity
Agents
Status
```

操作：

```text
Enable
Disable
Edit
Remove
```

---

# 91. M11.5 Skill Editor

第一版只需要：

```text
SKILL.md editor
```

可使用普通：

```text
textarea
```

或轻量 Editor。

后续再上：

```text
Monaco
CodeMirror
```

不要让 Editor 成为 MVP blocker。

---

# 92. M11.6 Create Skill UI

支持：

```text
Name
Description
Agent Assignment
```

创建后进入编辑器。

---

# 93. M11.7 Agents Page

显示：

```text
Claude Code
Detected
12 Skills

Codex
Detected
8 Skills
```

点击进入：

```text
Skill assignment
```

---

# 94. M11.8 Settings Page

第一版：

```text
Skillbox Home
Repository Path
Link Strategy
Web Port
Auto Open Browser
Agent Overrides
```

---

# 95. M11.9 Responsive Layout

至少支持：

```text
1280 desktop
768 tablet
```

不要求移动端优先。

这是本地开发者工具。

---

# 96. M11.10 Web Distribution

执行：

```bash
pnpm build
```

将 Frontend Static Assets 打进 NPM Package。

用户：

```bash
npx skillbox web
```

不需要单独安装 Web。

---

# 97. 0.1.0 Release Gate

完成以下功能即可发布：

```text
Agent Detection
Claude Adapter
Codex Adapter

Local Skill Scan
Import
Create
Edit
Remove

Canonical Library
Enable / Disable Agent

skillbox.yaml
skillbox.lock
Integrity

CLI
Interactive CLI
Web UI

macOS
Windows
Linux basic support
```

---

# 98. 0.1.0 End-to-End Acceptance Test

全新临时 HOME：

```text
Claude
Codex
```

各存在已有 Skill。

执行：

```bash
npx skillbox
```

必须能够：

1. Detect 两 Agent。
2. 找到 Existing Skills。
3. Import。
4. 生成 Manifest。
5. 生成 Lockfile。
6. 创建 Canonical Library。
7. Enable 同一个 Skill 给两个 Agent。
8. Edit Local Skill。
9. Integrity 识别为 modified。
10. Web UI 能查看和修改 Assignment。

---

# 99. M12 — GitHub Connect + Git Sync

## Target

```text
0.2.0
```

---

# 100. M12.1 Git Detection

执行：

```bash
git --version
```

不存在：

```text
GIT_NOT_FOUND
```

---

# 101. M12.2 GitClient

封装：

```ts
exec(args)
```

所有 Git 操作通过该层。

---

# 102. M12.3 git init

```bash
skillbox git init
```

在 Repository 初始化 Git。

---

# 103. M12.4 git connect

```bash
skillbox git connect <remote>
```

配置：

```text
origin
```

---

# 104. M12.5 git status

```bash
skillbox git status
```

显示：

```text
Branch
Remote
Ahead
Behind
Modified Files
```

---

# 105. M12.6 skillbox pull

执行：

```text
Git Fetch
↓
Pull
↓
Validate Manifest/Lock
↓
Reconcile
```

---

# 106. M12.7 skillbox push

流程：

```text
Validate
↓
Secret Scan
↓
Commit Optional
↓
Push
```

---

# 107. M12.8 skillbox sync

目标 UX：

```bash
skillbox sync
```

流程：

```text
Scan local changes
↓
Update integrity
↓
Fetch remote
↓
Merge
↓
Commit
↓
Push
↓
Reconcile
```

---

# 108. M12.9 Git Commit Message

自动 Commit 可采用：

```text
chore(skillbox): sync skills
```

更好：

```text
skillbox: sync 3 skill changes
```

后续可配置。

---

# 109. M12.10 Auto Commit Policy

需要提前固定：

默认：

```text
skillbox sync
```

可以自动 Commit Skillbox 管理文件。

但如果 Repository 还包含：

```text
非 Skillbox 文件
```

禁止自动提交这些文件。

只 Stage：

```text
skillbox.yaml
skillbox.lock
skills/
.skillbox/bases/
```

---

# 110. M12.11 Git Conflict Handling

如果：

```text
Manifest conflict
Lockfile conflict
Skill file conflict
```

停止自动流程。

返回：

```text
GIT_CONFLICT
```

Interactive UI 展示下一步。

---

# 111. M12.12 Multi-device E2E

创建：

```text
bare remote
device-a
device-b
```

测试：

```text
A create skill
A sync

B pull/install
B edit
B sync

A pull
```

必须正确。

---

# 111A. M12.13 GitHub App Registration

**Priority:** P0 for 0.2

建立 Skillbox GitHub App，并启用 Device Flow。权限保持最小化：

```text
Metadata: read
Contents: read/write
Administration: write only for repository creation
```

NPM 包只允许包含 Client ID，不得包含 Client Secret。

### Definition of Done

```text
Device Flow enabled
Permission rationale documented
No client secret in source, package or CI artifact
Development and production App identifiers separable
```

---

# 111B. M12.14 GitHub Device Flow

**Priority:** P0 for 0.2

实现 `skillbox github connect`，支持 user code、verification URL、浏览器打开、轮询、取消、过期、拒绝、slow_down 和网络重试。

### Definition of Done

```text
CLI and Web use the same Core service
Polling follows provider interval
Cancellation leaves repository unchanged
Connected account is verified with current-user API
```

---

# 111C. M12.15 CredentialStore

**Priority:** P0 for 0.2

定义统一 CredentialStore，并实现 macOS Keychain、Windows Credential Manager 和 Linux Secret Service。

### Definition of Done

```text
Access and refresh tokens never enter JSON config
Read/write/delete covered by platform tests
Missing or locked store returns typed actionable errors
Logs and debug bundles redact credentials
```

---

# 111D. M12.16 Token Lifecycle

**Priority:** P0 for 0.2

实现 access token expiry、refresh token rotation、刷新失败和重新授权状态。

### Definition of Done

```text
Refresh occurs before an authenticated operation when required
Rotated credentials are stored atomically
Invalid refresh token asks for reauthorization
No infinite refresh loop
```

---

# 111E. M12.17 GitHub Repository API

**Priority:** P0 for 0.2

支持 current user、Repository list、Repository create 和 Repository metadata。新 Repository 默认 Private；Public 必须由用户显式选择。

### Definition of Done

```text
Create and select flows work from CLI and Web
Name collision is actionable
Permission denial explains required permission
Pagination is handled for repository selection
```

---

# 111F. M12.18 Repository Setup Orchestrator

**Priority:** P0 for 0.2

编排：

```text
Create/select remote
→ git init when needed
→ add ordinary HTTPS origin
→ initial commit
→ push main
```

流程必须幂等、可重试，并保留现有未提交内容。

---

# 111G. M12.19 Git HTTPS Credential Bridge

**Priority:** P0 for 0.2

向 System Git 临时提供 GitHub App user token。禁止 token 出现在 remote URL、`.git/config`、进程参数或日志中。

同时验证无 Skillbox 登录时，SSH、Git Credential Manager 和手动 remote 仍可使用。

---

# 111H. M12.20 GitHub Settings UI

**Priority:** P0 for 0.2

CLI / Web 至少展示：

```text
Connected account
Repository
Visibility
Branch
Authentication source
Last sync
Sync now
Open repository
Disconnect
```

---

# 111I. M12.21 Disconnect GitHub

**Priority:** P0 for 0.2

删除 CredentialStore token 和本机连接 metadata；不删除本地 Repository、远程 Repository、Skills 或 Git remote。操作前明确展示该边界。

---

# 111J. M12.22 GitHub Integration E2E

**Priority:** P0 for 0.2

覆盖：

```text
Connect → authorize → create private repo → initial sync
Connect → select existing repo → sync
Expired token → refresh → sync
Refresh failure → reauthorize
Disconnect → local data preserved
Advanced SSH remote without GitHub Connect
```

测试不得依赖个人 GitHub 账号；使用隔离测试 App、mock server 或可清理的专用测试组织。

---

# 112. M13 — Secret Scan

建议和 Git 同版本完成。

---

# 113. M13.1 Secret Pattern Scanner

扫描：

```text
Git staged Skillbox-owned changed files
```

检测：

```text
Private key
GitHub token
OpenAI API key
Anthropic API key
AWS key
generic bearer token
```

---

# 114. M13.2 Secret Severity

```text
High confidence
→ block

Medium
→ warning
```

---

# 115. M13.3 Ignore Once

Interactive：

```text
Ignore once
```

仅本次 Push 有效。

---

# 116. M13.4 .skillboxignore

实现：

```text
.gitignore-compatible patterns
```

影响：

```text
Import
Integrity
Security Scan
Sync
```

---

# 117. M13.5 Secret E2E

创建：

```text
skills/foo/.env
```

包含模拟 Key。

执行：

```bash
skillbox push
```

必须被阻止。

---

# 118. 0.2.0 Acceptance Criteria

普通用户首次使用：

```text
npx skillbox
→ Connect GitHub
→ Complete Device Flow
→ Create private skillbox-skills repository
→ Initial sync succeeds
```

不需要手动打开 GitHub 创建仓库、复制 URL 或单独配置 Git credential。

Mac / Windows 两个测试环境：

Device A：

```bash
skillbox create test
skillbox sync
```

Device B：

```bash
git clone ...
skillbox install
```

必须恢复：

```text
Skills
Agent assignment
Integrity
```

且无 Machine-specific path 泄漏。

同时必须证明：

```text
Tokens only exist in OS Credential Store
Token refresh and reauthorization work
No token appears in remote, logs or debug bundle
Disconnect preserves all local and remote data
Generic Git / SSH remains functional without GitHub Connect
```

---

# 119. M14 — Registry Framework

## Target

```text
0.3.0
```

---

# 120. M14.1 RegistryProvider Interface

实现：

```ts
search()
resolve()
download()
getLatestRevision()
```

---

# 121. M14.2 Provider Registry

支持：

```ts
registerProvider()
resolveProvider()
```

---

# 122. M14.3 GitHub Provider

输入：

```text
github source
```

能够：

```text
resolve branch/tag to commit
download skill subtree
calculate integrity
```

---

# 123. M14.4 skills.sh Provider

能力：

```text
search
resolve
metadata
security info
```

如果 API 能力变化：

> Provider 内隔离。

---

# 124. M14.5 Source Parser

支持：

```bash
skillbox add vercel-labs/agent-skills@react-best-practices
```

解析成标准：

```yaml
type: github
repo: ...
path: ...
```

---

# 125. M14.6 skillbox search

```bash
skillbox search react
```

输出：

```text
NAME
SOURCE
POPULARITY
SECURITY
```

---

# 126. M14.7 Web Explore

加入页面：

```text
Explore
```

功能：

```text
Search
Trending
Official
Install
```

---

# 127. M15 — Remote Install

---

# 128. M15.1 Install Transaction

必须：

```text
Resolve
↓
Download Temp
↓
Path Validate
↓
Structure Validate
↓
Integrity
↓
Security
↓
Materialize
↓
Manifest
↓
Lock
↓
Agents
```

任何失败：

```text
Rollback
```

---

# 129. M15.2 Managed Skill

Remote Install 默认：

```text
mode = managed
```

完整文件：

```text
不进入 repository skills/
```

---

# 130. M15.3 Managed Cache

缓存：

```text
~/.skillbox/cache/
```

Cache 可随时删除。

---

# 131. M15.4 Runtime Managed Materialization

Managed Skill Runtime：

```text
~/.skillbox/library/<alias>
```

由 Locked Revision 生成。

---

# 132. M15.5 Managed Integrity Verification

下载内容 Hash：

必须等于 Lockfile。

否则：

```text
INTEGRITY_MISMATCH
```

---

# 133. M15.6 Remote Restore

新设备：

```bash
skillbox install
```

根据：

```text
Lockfile revision
```

而不是 Manifest Latest。

---

# 134. M16 — Update Management

---

# 135. M16.1 Outdated Detection

```bash
skillbox outdated
```

比较：

```text
Locked Revision
Latest Upstream Revision
```

---

# 136. M16.2 Managed Update

```bash
skillbox update foo
```

成功后：

```text
Lockfile revision changes
Runtime replaced
Agent links remain
```

---

# 137. M16.3 Web Updates Page

展示：

```text
Skill
Installed
Latest
Changes
Update
```

---

# 138. M16.4 View Remote Diff

P1。

至少可以展示：

```text
changed files
```

后续再做完整 Diff Editor。

---

# 139. 0.3.0 Acceptance Criteria

执行：

```bash
skillbox search react
```

找到 Skill。

执行：

```bash
skillbox add ...
```

安装到：

```text
Claude
Codex
```

Git Repository：

```text
只增加 Manifest + Lock
```

而不是第三方全部文件。

新设备：

```bash
skillbox install --frozen-lockfile
```

安装相同 Revision。

---

# 140. M17 — Fork

## Target

```text
0.4.0
```

---

# 141. M17.1 Managed → Forked

命令：

```bash
skillbox fork foo
```

实现：

```text
Copy Managed Runtime
↓
skills/foo/
↓
Source → local
↓
Mode → forked
↓
Set Upstream
↓
Save Base Revision
↓
Save Base Snapshot
```

---

# 142. M17.2 Automatic Fork on Edit

执行：

```bash
skillbox edit managed-skill
```

提示：

```text
Editing will create a local fork.
```

确认后自动 Fork。

---

# 143. M17.3 External Managed Modification Detection

如果用户直接修改 Managed Runtime：

提示：

```text
Managed skill has local changes.

Convert to Fork?
Restore?
```

---

# 144. M17.4 Base Snapshot

Repository：

```text
.skillbox/bases/<alias>/<revision>/
```

必须进入 Git。

---

# 145. M17.5 Fork Lockfile

保存：

```text
baseRevision
baseIntegrity
latestRevision
```

---

# 146. M18 — Vendor

---

# 147. M18.1 Managed → Vendored

```bash
skillbox vendor foo
```

完整复制进：

```text
skills/foo
```

取消 Active Upstream。

---

# 148. M18.2 Forked → Vendored

停止 Upstream Tracking。

保留内容。

可以清理 Base Snapshot。

---

# 149. M18.3 Provenance

P2：

可以保存：

```text
original source
```

但不能影响更新逻辑。

---

# 150. M19 — Diff

---

# 151. M19.1 Text Diff Engine

支持：

```text
Markdown
JSON
YAML
Text
Code
```

---

# 152. M19.2 Managed Diff

展示：

```text
Current
vs
Latest Upstream
```

---

# 153. M19.3 Forked Diff

展示：

```text
Base
Local
Upstream
```

---

# 154. M19.4 CLI Diff

```bash
skillbox diff foo
```

第一版可以直接输出 Unified Diff。

---

# 155. M19.5 Web Diff

P1。

推荐：

```text
Side-by-side
```

但不要阻塞 Core Diff。

---

# 156. M20 — 3-way Merge

---

# 157. M20.1 Text Merge

输入：

```text
Base
Local
Upstream
```

输出：

```text
Merged
Conflicts
```

---

# 158. M20.2 File Tree Merge

情况：

```text
Local added file
Upstream added file
Local deleted file
Upstream changed file
```

需要定义规则。

---

# 159. M20.3 Binary Conflict

二进制：

禁止自动 merge。

要求选择：

```text
Keep Local
Use Upstream
```

---

# 160. M20.4 Merge Success

更新：

```text
skills/foo
baseRevision
baseSnapshot
latestRevision
integrity
```

---

# 161. M20.5 Merge Conflict State

发生冲突：

```text
status = conflict
```

不能提前更新：

```text
baseRevision
```

---

# 162. M20.6 Resolve Conflict

提供：

```bash
skillbox merge foo --continue
```

类似 Git。

检测用户已解决冲突。

然后完成 Metadata 更新。

---

# 163. M20.7 Abort

```bash
skillbox merge foo --abort
```

恢复 Merge 前状态。

---

# 164. M20.8 Backup

Merge 前在 Runtime Temp / Backup 中保存当前状态。

---

# 165. 0.4.0 Acceptance Criteria

场景：

1. Install Remote Skill。
2. Fork。
3. 修改本地 `SKILL.md`。
4. Upstream 更新同一 Skill。
5. `skillbox outdated` 检测更新。
6. `skillbox diff` 展示变化。
7. `skillbox merge` 执行 3-way merge。
8. 无冲突时更新 Base。
9. 有冲突时进入 Conflict。
10. 新设备从 Git Clone 后仍然可以继续 Merge。

---

# 166. M21 — Security Scanner

---

# 167. M21.1 Static Rule Engine

Scanner Interface：

```ts
scanSkill()
```

返回：

```text
findings
risk
```

---

# 168. M21.2 Initial Rules

检测：

```text
curl | bash
wget | sh
sudo
rm -rf
PowerShell invoke
SSH directory
credential env
network access
external executable
```

---

# 169. M21.3 Risk Levels

```text
LOW
MEDIUM
HIGH
CRITICAL
```

---

# 170. M21.4 Install Confirmation

Remote Skill：

```text
LOW
→ normal install

MEDIUM
→ warning

HIGH
→ strong warning

CRITICAL
→ default block
```

---

# 171. M21.5 Security Provider Metadata

如果：

```text
skills.sh
```

已经提供第三方 Audit：

合并显示：

```text
Skillbox Static Scan
External Security Scan
```

两者不要互相覆盖。

---

# 172. M21.6 Web Security UI

Skill Detail：

```text
Risk
Findings
Affected Files
Scanner Sources
```

---

# 173. Testing Strategy

每个 Milestone 必须同时补测试。

禁止：

> 所有功能做完以后再补测试。

---

# 174. Test Pyramid

```text
Unit
↑ many

Integration
↑ medium

E2E
↑ few
```

---

# 175. Required Unit Test Areas

```text
Manifest parsing
Lockfile parsing
Integrity
Path safety
Mode validation
State transition
Source parsing
Ignore patterns
```

---

# 176. Required Integration Tests

```text
Create Local Skill
Import Existing Skill
Enable Agent
Disable Agent
Reconcile
Git Sync
Remote Install
Update
Fork
Vendor
Merge
```

---

# 177. Cross-platform Tests

重点：

```text
Windows
macOS
Linux
```

特别覆盖：

```text
path normalization
symlink/junction
line endings
Git
```

---

# 178. Fixture HOME

所有测试必须尽量使用：

```text
temporary HOME
```

不要修改开发者真实：

```text
~/.claude
~/.codex
~/.skillbox
```

---

# 179. Agent Adapter Fixtures

例如：

```text
fixtures/
├── home-claude/
├── home-codex/
└── home-multiple/
```

---

# 180. Git Fixture

```text
tmp/
├── remote.git
├── device-a/
└── device-b/
```

用于模拟 Multi-device。

---

# 181. Security Tests

恶意 Fixture：

```text
path traversal
external symlink
private key
api token
curl | bash
```

必须纳入自动测试。

---

# 182. Performance Targets

MVP 不需要过度优化。

但建议基本目标：

```text
100 Skills scan
< 1 second typical local filesystem

CLI startup
< 500ms desirable

Web first API
< 500ms typical
```

不是硬 SLA。

---

# 183. Scalability Target

第一版至少保证：

```text
500 Skills
10 Agents
3 Devices
```

不会出现架构性问题。

不需要针对：

```text
100k Skills
```

优化。

---

# 184. Logging Tasks

实现：

```text
normal
verbose
debug
```

CLI：

```bash
skillbox --verbose
skillbox --debug
```

---

# 185. Debug Bundle

P2：

```bash
skillbox doctor
```

输出：

```text
Skillbox Version
Node Version
OS
Git Version
Detected Agents
Config
Repository Status
```

必须脱敏。

---

# 186. Doctor Command

建议提升为 P1，因为开源工具非常有用。

```bash
skillbox doctor
```

检查：

```text
Node
Git
Repository
Manifest
Lockfile
Agent adapters
filesystem links
permissions
```

---

# 187. Documentation Tasks

0.1 发布前必须：

```text
README.md
INSTALLATION.md
CONTRIBUTING.md
LICENSE
PRD.md
ARCHITECTURE.md
SKILLBOX_SPEC.md
MVP_TASKS.md
```

---

# 188. README Minimum Content

```text
What is Skillbox

Quick Start

npx skillbox

Supported Agents

Features

Screenshots

Git Sync Roadmap

Architecture Summary

Contributing
```

---

# 189. Quick Start

最终 README 应尽量做到：

```bash
npx skillbox
```

然后无需额外阅读即可完成首次使用。

---

# 190. NPM Publishing

发布前：

```text
npm package name availability
package files
bin executable
web static assets
license
README
```

测试：

```bash
npm pack
```

然后在空目录：

```bash
npx ./skillbox-x.y.z.tgz
```

验证。

---

# 191. Package Size

由于包含 Web UI：

关注：

```text
npm package size
```

避免：

```text
node_modules
source maps huge
test fixtures
screenshots
```

误打包。

---

# 192. Versioning

推荐：

```text
0.1.0
Local Skill Manager

0.2.0
Git Sync

0.3.0
Remote Registry

0.4.0
Fork / Merge

0.5+
Advanced lifecycle
```

---

# 193. Release Channel

早期：

```text
latest
next
```

例如：

```bash
npx skillbox@next
```

测试 Beta。

---

# 194. Breaking Changes

在：

```text
0.x
```

阶段允许较快演进。

但：

```text
skillbox.yaml
skillbox.lock
```

必须谨慎。

任何 Schema Breaking Change：

需要：

```text
migration
```

---

# 195. Coding Agent Work Rules

如果将本文档交给 Coding Agent，应要求遵循：

```text
1. 一次只实现一个 Task / Epic。

2. 不提前实现未要求的 Future Scope。

3. 修改 Core API 前检查 ARCHITECTURE.md。

4. 修改 Manifest / Lockfile 前检查 SKILLBOX_SPEC.md。

5. 所有新业务逻辑进入 Core。

6. CLI/Web 不直接操作 Skill 文件。

7. 每个 Task 同时补测试。

8. 不修改真实用户 HOME。

9. 不 hardcode Agent 用户路径。

10. Windows/macOS/Linux path 使用 Node Path API。

11. 不在 Manifest / Lockfile 写 Machine-specific path。

12. destructive operation 必须保守处理。

13. 不静默删除 External Skills。

14. 不静默覆盖 Managed Local Modification。

15. 不静默覆盖 Forked Skill。
```

---

# 196. Recommended Agent Execution Units

为了避免 Agent 一次修改过多文件，推荐每次任务大小：

```text
2–8 source files
+
tests
```

而不是：

```text
“实现整个 Skillbox”
```

---

# 197. Recommended First Coding Agent Prompt

第一轮：

```text
Read:

PRD.md
ARCHITECTURE.md
SKILLBOX_SPEC.md
MVP_TASKS.md

Implement only:

M0 — Project Foundation

Do not implement any Skill management behavior yet.

Requirements:

- TypeScript
- pnpm workspace
- Vitest
- ESLint
- Prettier
- packages/core
- packages/cli
- apps/web placeholders
- working skillbox CLI binary
- CI for Windows/macOS/Linux

At the end:

1. Run lint
2. Run typecheck
3. Run tests
4. Run build
5. Summarize changed files
```

---

# 198. Second Agent Prompt

完成 M0 后：

```text
Implement:

M1 Core Domain
+
M2 Filesystem Layer

Follow ARCHITECTURE.md and SKILLBOX_SPEC.md.

Do not implement CLI UI or Agent adapters yet.

Required:

- domain models
- typed errors
- filesystem abstraction
- atomic writes
- path safety
- skill directory scanning
- basic skill validation
- symlink safety
- tests
```

---

# 199. Third Agent Prompt

```text
Implement:

Manifest + Lockfile + Integrity

Requirements:

- skillbox.yaml v1
- skillbox.lock v1
- deterministic serialization
- SHA-256 canonical skill integrity
- local modification detection
- portable paths only
- tests for Windows-style and POSIX-style paths

Do not implement Git or remote skills.
```

---

# 200. Fourth Agent Prompt

```text
Implement Agent Adapter framework.

Start with:

Claude Code
Codex

Required:

- adapter interface
- adapter registry
- detectAll
- scan existing skills
- link/unlink
- fixture HOME tests

Do not touch the user's real Agent directories in tests.
```

---

# 201. Fifth Agent Prompt

```text
Implement:

Canonical Library
Runtime State
Import Existing Skill
Reconcile

Required:

- ~/.skillbox equivalent configurable test root
- runtime library
- links.json ownership
- import external skills as Local
- reconcile idempotency
- never delete external skills
```

---

# 202. Sixth Agent Prompt

```text
Implement the basic CLI.

Commands:

skillbox list
skillbox agents
skillbox create
skillbox remove
skillbox enable
skillbox disable
skillbox install
skillbox status

Requirements:

- --json for read commands
- no business logic in CLI
- all operations through Core
```

---

# 203. Seventh Agent Prompt

```text
Implement interactive CLI using @clack/prompts.

Running:

npx skillbox

without arguments should open interactive mode.

Implement:

- first-run detection
- import existing skills
- list/manage skills
- agent assignment
- create skill
- open web UI placeholder
```

---

# 204. Eighth Agent Prompt

```text
Implement local web server and React Web UI.

Pages:

Library
Agents
Settings

Requirements:

- bind 127.0.0.1 by default
- REST API backed by Core
- packaged static assets
- skillbox web
- --port
- --no-open
```

At this point:

```text
Skillbox 0.1.0
```

should be releasable.

---

# 205. Critical Path

真正的 Critical Path：

```text
M0
↓
M1/M2
↓
M3/M4
↓
M5
↓
M6
↓
M7
↓
M8
↓
M9
↓
M10/M11
```

其中最容易产生返工的是：

```text
Manifest
Lockfile
Canonical Library
Reconcile
Agent Adapter
```

所以这些模块应该优先写测试和文档。

---

# 206. Highest-risk Technical Areas

项目最需要提前验证的不是 Web UI。

而是：

## Risk 1

不同 Agent 的 Skills Directory 和识别方式。

## Risk 2

Windows Symlink / Junction 行为。

## Risk 3

多个 Agent 同名 Skill 冲突。

## Risk 4

Runtime Library 与 Agent Directory 同步。

## Risk 5

Git 多设备冲突。

## Risk 6

Fork Base Snapshot 设计。

## Risk 7

Integrity 跨平台一致性。

---

# 207. Recommended Technical Spikes

正式大量开发前建议做几个 Spike。

---

# 208. Spike A — Agent Paths

验证：

```text
Claude
Codex
Cursor
Gemini
OpenCode
```

真实 Skill Directory。

输出：

```text
AGENT_PATHS.md
```

不要只依赖记忆或猜测。

---

# 209. Spike B — Windows Links

写一个小脚本验证：

```text
symlink
junction
copy
```

在：

```text
Windows 10/11
PowerShell
non-admin user
```

环境表现。

---

# 210. Spike C — Integrity

同一个 Fixture：

在：

```text
Windows
macOS
Linux
```

计算 Hash。

要求一致。

---

# 211. Spike D — Git Multi-device

用：

```text
bare repo
device A
device B
```

模拟：

```text
simultaneous edits
manifest conflicts
lockfile conflicts
```

确认 Sync UX。

---

# 212. Spike E — skills.sh / GitHub Remote

验证：

```text
Search
Resolve
Exact revision
Download subtree
Security metadata
```

再确定 Provider 实现。

---

# 213. Non-MVP Tasks

明确不要在 0.1 开发：

```text
MCP Manager
Rules Manager
Prompt Manager
Team SaaS
Accounts
Cloud Backend
Billing
Enterprise RBAC
Plugin Marketplace
Desktop App
Mobile App
VS Code Extension
Full-screen terminal dashboard
AI Skill Generator
Skill Dependency Graph
```

---

# 214. Product Discipline

遇到新想法：

先判断：

```text
是否直接帮助：

统一管理 Skill
跨 Agent
跨设备
版本控制
```

如果不是：

优先放入：

```text
BACKLOG.md
```

不要进入当前 Milestone。

---

# 215. Suggested GitHub Labels

Issues：

```text
type:feature
type:bug
type:refactor
type:docs
type:test

area:core
area:cli
area:web
area:agent
area:git
area:registry
area:security

priority:p0
priority:p1
priority:p2
priority:p3

status:blocked
status:ready
status:in-progress
```

---

# 216. Suggested GitHub Milestones

创建：

```text
0.1 — Local Skills

0.2 — Git Sync

0.3 — Registry

0.4 — Fork & Merge
```

---

# 217. Definition of Done — General

任何 Feature 只有满足以下条件才算完成：

```text
Implementation complete

Tests added

Typecheck passes

Lint passes

No known destructive behavior

Cross-platform considerations reviewed

Docs updated if public behavior changed
```

---

# 218. Definition of Done — Core

Core Feature 必须：

```text
No CLI dependency

No Web dependency

Typed errors

Unit tests

Deterministic behavior where required
```

---

# 219. Definition of Done — Agent Adapter

Adapter 必须：

```text
Detection tested

Path tested

Scan tested

Enable tested

Disable tested

External Skill preserved

Fixture HOME tests
```

---

# 220. Definition of Done — Git

Git Feature 必须：

```text
Local repo test

Remote repo test

Conflict test

No credential logging

No unrelated files staged

No token in URL, config, arguments or logs

Credential lifecycle tested

GitHub API and Git transport failures distinguished

Generic Git works without GitHub Connect
```

---

# 221. Definition of Done — Web

Web Feature 必须：

```text
Core-backed

No direct filesystem access

Loading state

Error state

Empty state

Keyboard accessible basics
```

---

# 222. Definition of Done — Security

Security Feature 必须：

```text
True-positive fixtures

False-positive consideration

Severity

File path

Reason shown

Override explicitly recorded at runtime
```

---

# 223. Release 0.1 Checklist

```text
[ ] Claude detection
[ ] Codex detection
[ ] Local skill scan
[ ] External skill import
[ ] Canonical library
[ ] Manifest
[ ] Lockfile
[ ] Integrity
[ ] Create skill
[ ] Edit skill
[ ] Remove skill
[ ] Agent enable/disable
[ ] Reconcile
[ ] CLI
[ ] Interactive CLI
[ ] Web UI
[ ] Windows CI
[ ] macOS CI
[ ] Linux CI
[ ] README
[ ] npm pack test
```

---

# 224. Release 0.2 Checklist

```text
[ ] Git detection
[ ] Git init
[ ] Git connect
[ ] GitHub App registration and least-privilege permissions
[ ] GitHub Device Flow
[ ] Current user
[ ] Repository list
[ ] Create private repository by default
[ ] Select existing repository
[ ] OS Credential Store on Windows/macOS/Linux
[ ] Token refresh and reauthorization
[ ] Temporary Git HTTPS credential bridge
[ ] GitHub Settings UI
[ ] Disconnect without deleting data
[ ] Git status
[ ] Pull
[ ] Push
[ ] Sync
[ ] Secret scan
[ ] .skillboxignore
[ ] Multi-device E2E
[ ] Restore from clone
[ ] GitHub Connect E2E
[ ] Advanced SSH / Generic Git regression test
```

---

# 225. Release 0.3 Checklist

```text
[ ] Registry abstraction
[ ] GitHub provider
[ ] skills.sh provider
[ ] Search
[ ] Remote install
[ ] Managed mode
[ ] Exact revision lock
[ ] Remote integrity
[ ] Outdated
[ ] Managed update
[ ] Explore UI
[ ] Updates UI
```

---

# 226. Release 0.4 Checklist

```text
[ ] Fork mode
[ ] Vendored mode
[ ] Automatic fork on edit
[ ] Base revision
[ ] Base snapshot
[ ] Managed diff
[ ] Fork diff
[ ] 3-way merge
[ ] Conflict state
[ ] Merge continue
[ ] Merge abort
[ ] Cross-device fork restore
```

---

# 227. Final Delivery Goal

完成 0.1 后，用户应该能够：

```bash
npx skillbox
```

然后：

```text
自动发现 Agent
↓
导入现有 Skills
↓
统一管理
↓
跨 Agent 启用
↓
创建/修改自己的 Skill
↓
通过 Web UI 可视化管理
```

完成 0.2：

```text
GitHub
↓
跨设备同步
```

完成 0.3：

```text
Marketplace
↓
安装第三方 Skill
↓
精确版本锁定
```

完成 0.4：

```text
Third-party Skill
↓
Customize
↓
Fork
↓
Track Upstream
↓
Diff
↓
Merge
```

最终形成：

```text
                  Skillbox

                     │
        ┌────────────┼────────────┐
        │            │            │
      Local        Remote       GitHub
        │            │            │
        └────────────┼────────────┘
                     │
                     ▼
              Canonical Library
                     │
          ┌──────────┼──────────┐
          │          │          │
          ▼          ▼          ▼
       Claude      Codex      Cursor
```

核心产品价值：

> **One library. Every agent. Every device.**

---

# 228. Recommended Immediate Next Step

在正式写代码前，建议先完成以下三个技术验证：

```text
1. Agent Path Spike
2. Windows Link Spike
3. Integrity Cross-platform Spike
```

然后立即进入：

```text
M0
↓
M1
↓
M2
```

不要先开发 Web UI。

因为 Skillbox 最核心、最难返工的部分并不是 UI，而是：

```text
Source Model
Manifest
Lockfile
Runtime Library
Agent Adapter
Reconcile
```

这些基础一旦稳定，CLI、TUI 和 Web UI 都只是不同的交互层。

---

# 229. Final Rule

整个 MVP 开发过程中，应始终坚持：

> **Make the package manager work before making the package manager beautiful.**

也就是：

```text
Correctness
↓
Reproducibility
↓
Safety
↓
Cross-platform
↓
Developer Experience
↓
UI Polish
```

而不是反过来。

Skillbox 第一阶段真正需要证明的不是：

> “我们能做一个漂亮的 Skills GUI。”

而是：

> **“我们能够可靠地理解、管理、恢复和同步用户的 Agent Skills 环境。”**

一旦这一点成立，后续的 Marketplace、Diff、Merge、Security、MCP 和 Agent Environment 扩展都会自然建立在同一套 Core 之上。
