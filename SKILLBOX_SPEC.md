# Skillbox Specification

> File: `SKILLBOX_SPEC.md`
> Status: Draft
> Version: 0.2
> Specification Version: 1
> Last Updated: 2026-08-09

---

# 1. Purpose

本文档定义 Skillbox 的核心数据协议和行为规范，包括：

- `skillbox.yaml`
- `skillbox.lock`
- Skill Source
- Skill Identity
- Skill Mode
- Skill Status
- Managed / Forked / Local / Vendored 状态
- Agent Assignment
- Integrity Hash
- Reproducible Installation
- Repository Layout
- Reconcile
- Update
- Fork
- Vendor
- Merge
- Cross-device Restore
- Schema Versioning

目标：

> 任何兼容本规范的 Skillbox 实现，都应该能够根据同一个 Repository 恢复等价的 Agent Skills 环境。

---

# 2. Core State Model

Skillbox 使用三层状态模型：

```text
Desired State
     │
     ▼
Resolved State
     │
     ▼
Runtime State
```

分别对应：

```text
skillbox.yaml
     │
     ▼
skillbox.lock
     │
     ▼
Runtime Library + Agent Links
```

---

# 3. Desired State

Desired State 表达：

> 用户希望安装和启用什么。

由：

```text
skillbox.yaml
```

描述。

Desired State：

- 可人工编辑
- 可读
- 可版本控制
- 不包含机器特定信息
- 不要求记录完整解析结果

---

# 4. Resolved State

Resolved State 表达：

> 当前 Desired State 被解析成了什么精确版本。

由：

```text
skillbox.lock
```

描述。

Resolved State 必须包含：

```text
Exact Revision
Integrity
Resolved Source
Mode
```

必要时包含：

```text
Upstream Base Revision
Resolved Files Metadata
```

---

# 5. Runtime State

Runtime State 表达：

> 当前机器实际上安装和链接了什么。

包括：

```text
~/.skillbox/library/
~/.skillbox/cache/
~/.skillbox/state/
Agent Skill Directories
```

Runtime State：

> 不进入 Git。

它可以根据：

```text
skillbox.yaml
+
skillbox.lock
+
skills/
```

重新生成。

---

# 6. Repository Root

一个 Skillbox Repository 根目录必须至少包含：

```text
skillbox.yaml
```

推荐同时包含：

```text
skillbox.lock
```

标准结构：

```text
repository/
│
├── skillbox.yaml
├── skillbox.lock
├── .skillboxignore
├── .gitignore
│
└── skills/
```

---

# 7. Minimal Repository

合法的最小 Repository：

```text
repository/
└── skillbox.yaml
```

例如：

```yaml
version: 1

skills: {}
```

---

# 8. skillbox.yaml

`skillbox.yaml` 是 Skillbox Manifest。

推荐结构：

```yaml
version: 1

name: my-agent-skills

skills: {}

agents: {}

settings: {}
```

其中只有：

```yaml
version: 1
```

和：

```yaml
skills:
```

是核心字段。

---

# 9. Manifest Top-level Schema

概念定义：

```ts
interface SkillboxManifest {
  version: number

  name?: string

  description?: string

  skills: Record<string, ManifestSkill>

  agents?: Record<string, ManifestAgentConfig>

  settings?: ManifestSettings
}
```

---

# 10. version

必须：

```yaml
version: 1
```

代表：

> Manifest Schema Version。

它不是：

```text
Skillbox CLI Version
```

也不是：

```text
Repository Version
```

未来：

```yaml
version: 2
```

表示协议发生不兼容或需要迁移的变化。

---

# 11. name

可选：

```yaml
name: my-agent-environment
```

主要用于：

```text
UI
CLI
Team Repository
Profiles
```

不参与 Skill Identity。

---

# 12. description

可选：

```yaml
description: My personal Agent Skills environment
```

仅用于显示。

---

# 13. skills

核心字段：

```yaml
skills:
```

Key 是：

```text
Skill Alias
```

例如：

```yaml
skills:
  react-best-practices:
```

这里的：

```text
react-best-practices
```

是 Repository 内的稳定 Logical ID。

---

# 14. Skill Alias

Skill Alias 必须：

```text
在当前 Manifest 内唯一
```

推荐格式：

```regex
^[a-z0-9][a-z0-9-_]*$
```

合法：

```text
react-best-practices
my-review
backend_rules
```

不推荐：

```text
React Best Practices
my skill
../../foo
```

---

# 15. ManifestSkill

概念：

```ts
interface ManifestSkill {
  source: SkillSource

  mode?: SkillMode

  agents?: string[]

  enabled?: boolean

  metadata?: Record<string, unknown>
}
```

---

# 16. Skill Source

Skill Source 表示：

> 这个 Skill 从哪里来。

第一版标准 Source 类型：

```text
github
git
registry
local
```

---

# 17. GitHub Source

格式：

```yaml
source:
  type: github
  repo: vercel-labs/agent-skills
  path: skills/react-best-practices
```

可选：

```yaml
  ref: main
```

完整：

```yaml
source:
  type: github
  repo: vercel-labs/agent-skills
  path: skills/react-best-practices
  ref: main
```

---

# 18. GitHub Source Schema

```ts
interface GitHubSkillSource {
  type: 'github'

  repo: string

  path?: string

  ref?: string
}
```

`repo` 推荐格式：

```text
owner/repository
```

例如：

```text
vercel-labs/agent-skills
```

---

# 19. Git Source

用于任意 Git Repository：

```yaml
source:
  type: git
  url: git@github.com:company/internal-skills.git
  path: backend/code-review
  ref: main
```

Schema：

```ts
interface GitSkillSource {
  type: 'git'

  url: string

  path?: string

  ref?: string
}
```

---

# 20. Registry Source

例如：

```yaml
source:
  type: registry
  registry: skills.sh
  package: vercel-labs/agent-skills/react-best-practices
```

Schema：

```ts
interface RegistrySkillSource {
  type: 'registry'

  registry: string

  package: string

  version?: string
}
```

---

# 21. Local Source

用于 Repository 中完整保存的 Skill：

```yaml
source:
  type: local
  path: ./skills/my-code-review
```

Schema：

```ts
interface LocalSkillSource {
  type: 'local'

  path: string
}
```

---

# 22. Portable Paths

所有 Local Path 必须：

> 相对于 Repository Root。

合法：

```yaml
path: ./skills/my-code-review
```

禁止共享 Manifest 中出现：

```yaml
path: /Users/user/projects/skills/my-code-review
```

或：

```yaml
path: C:\Users\User\skills\my-code-review
```

---

# 23. Source Normalization

不同输入可能表示同一个 Source。

例如：

```text
github:vercel-labs/agent-skills
```

和：

```text
https://github.com/vercel-labs/agent-skills
```

Core 应在解析后生成：

```text
Canonical Source
```

但：

> Manifest 可以保留用户可读表达。

Lockfile 必须保存标准化后的 Source。

---

# 24. Skill Mode

Skillbox 定义：

```ts
type SkillMode =
  | 'managed'
  | 'forked'
  | 'local'
  | 'vendored'
```

---

# 25. Default Mode

如果 Manifest 没有指定：

```yaml
mode:
```

则根据 Source 推导。

规则：

```text
source.type == local
    ↓
local

remote source
    ↓
managed
```

---

# 26. Managed Mode

Managed：

> 第三方来源，用户未修改，由 upstream 管理。

Manifest：

```yaml
skills:
  react-best-practices:
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices

    mode: managed
```

`mode: managed` 可以省略。

---

# 27. Managed Storage Rule

Managed Skill 的完整文件：

> 默认不进入 Repository。

它应该存在：

```text
Runtime Library
Cache
```

Lockfile 保存精确版本。

---

# 28. Forked Mode

Forked：

> 来源于第三方，但已经被用户修改，同时继续保留 upstream 关系。

Manifest 推荐：

```yaml
skills:
  react-best-practices:
    mode: forked

    source:
      type: local
      path: ./skills/react-best-practices

    upstream:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
```

因此 Forked 的 Schema 需要额外：

```ts
interface ManifestSkill {
  source: SkillSource

  mode?: SkillMode

  upstream?: SkillSource

  agents?: string[]
}
```

---

# 29. Forked Source Rule

Forked Skill：

```text
source
```

应该指向：

> 当前用户实际维护的 Local Copy。

而：

```text
upstream
```

指向：

> 原第三方来源。

这样语义最清晰。

---

# 30. Forked Example

```yaml
skills:
  react-best-practices:
    mode: forked

    source:
      type: local
      path: ./skills/react-best-practices

    upstream:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices

    agents:
      - claude
      - codex
```

---

# 31. Local Mode

Local：

> 用户原创 Skill。

例如：

```yaml
skills:
  my-code-review:
    mode: local

    source:
      type: local
      path: ./skills/my-code-review

    agents:
      - claude
      - codex
```

`mode: local` 可以根据 Source 自动推导。

---

# 32. Vendored Mode

Vendored：

> 原本可能来自第三方，但现在已经完全转为本地维护。

推荐 Manifest：

```yaml
skills:
  frontend-design:
    mode: vendored

    source:
      type: local
      path: ./skills/frontend-design
```

默认不再保留：

```yaml
upstream:
```

---

# 33. Optional Provenance for Vendored

为了历史可追溯，可允许：

```yaml
metadata:
  originalSource:
    type: github
    repo: foo/bar
```

但是：

> originalSource 不参与 update。

不要把它等同于 upstream。

---

# 34. Mode Summary

```text
Managed
Remote Source
No Local Full Copy in Repository
Track Upstream

Forked
Local Source
Has Upstream
Track Upstream

Local
Local Source
No Upstream

Vendored
Local Source
No Active Upstream
```

---

# 35. Valid Mode / Source Combinations

合法：

| Mode | Source | Upstream |
|---|---|---|
| Managed | Remote | Optional/Implicit |
| Forked | Local | Required |
| Local | Local | Forbidden/None |
| Vendored | Local | None |

---

# 36. Invalid Combinations

例如：

```yaml
mode: managed

source:
  type: local
```

默认判定：

```text
INVALID_MODE_SOURCE_COMBINATION
```

---

# 37. Agent Assignment

Skill 可以指定在哪些 Agent 启用。

例如：

```yaml
agents:
  - claude
  - codex
```

含义：

> 在当前设备检测到对应 Agent 时，将 Skill Materialize / Link 到该 Agent。

---

# 38. Empty Agent List

```yaml
agents: []
```

表示：

> Skill 被安装和管理，但暂时不暴露给任何 Agent。

---

# 39. Missing agents Field

如果：

```yaml
agents:
```

缺失，推荐默认：

```text
all-compatible-detected-agents
```

还是：

```text
none
```

必须固定一种行为。

本规范推荐：

> 缺失时使用 Repository / Global Default。

如果没有 Default：

```text
none
```

这是更安全的默认值。

因此不会因为安装 Skill 自动散布到所有 Agent。

---

# 40. Global Agent Defaults

Manifest 可以：

```yaml
settings:
  defaultAgents:
    - claude
    - codex
```

那么：

```yaml
skills:
  foo:
    source: ...
```

等价于：

```yaml
agents:
  - claude
  - codex
```

---

# 41. Agent Identifier

标准 Agent ID 推荐全部小写：

```text
claude
codex
cursor
gemini
opencode
```

显示名称由 Adapter 提供：

```text
claude
→ Claude Code
```

---

# 42. Unknown Agents

如果 Repository 中：

```yaml
agents:
  - future-agent
```

而本机 Skillbox 不认识：

> 不应该直接删除这个值。

应：

```text
Preserve Unknown Agent IDs
Warn
Skip Runtime Assignment
```

这样避免旧客户端破坏未来字段。

---

# 43. Manifest Example

完整示例：

```yaml
version: 1

name: my-agent-skills

description: Shared development skills

settings:
  defaultAgents:
    - claude
    - codex

skills:

  react-best-practices:
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices

    mode: managed

  my-code-review:
    source:
      type: local
      path: ./skills/my-code-review

    mode: local

  frontend-design:
    mode: forked

    source:
      type: local
      path: ./skills/frontend-design

    upstream:
      type: github
      repo: anthropics/skills
      path: skills/frontend-design

    agents:
      - claude
```

---

# 44. skillbox.lock

`skillbox.lock` 是机器无关、可提交 Git 的 Resolved State。

推荐 YAML。

例如：

```yaml
lockfileVersion: 1

skills: {}
```

---

# 45. Lockfile Principles

Lockfile 必须：

```text
Deterministic
Portable
Machine-independent
Reproducible
```

不应该包含：

```text
absolute local path
temporary directory
cache path
username
hostname
OS-specific agent path
```

---

# 46. Lockfile Schema

概念：

```ts
interface SkillboxLockfile {
  lockfileVersion: number

  generatedBy?: string

  skills: Record<string, LockedSkill>
}
```

---

# 47. generatedBy

可选：

```yaml
generatedBy: skillbox@0.4.1
```

仅用于诊断。

它不能决定：

```text
Compatibility
```

Compatibility 应由：

```text
lockfileVersion
```

决定。

---

# 48. LockedSkill

推荐：

```ts
interface LockedSkill {
  mode: SkillMode

  source: ResolvedSkillSource

  revision?: string

  integrity: string

  upstream?: LockedUpstream

  metadata?: LockedSkillMetadata
}
```

---

# 49. Resolved Source

Manifest：

```yaml
ref: main
```

可能被解析成：

```yaml
revision: 07a81df7a84e...
```

Lockfile 应记录精确：

```yaml
source:
  type: github
  repo: vercel-labs/agent-skills
  path: skills/react-best-practices

revision: 07a81df7a84e9174...
```

---

# 50. Mutable Ref vs Immutable Revision

Manifest 可以使用：

```text
main
latest
v1
```

这种 Human Intent。

Lockfile 必须尽可能解析为：

```text
commit SHA
content digest
immutable version
```

因此：

```text
Manifest
main

Lockfile
07a81df7a84e...
```

---

# 51. Managed Lock Entry

例如：

```yaml
skills:
  react-best-practices:

    mode: managed

    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices

    revision: 07a81df7a84e91744ad313

    integrity: sha256:73b9173f...
```

---

# 52. Local Lock Entry

Local Skill 也建议保存 Integrity：

```yaml
skills:
  my-code-review:

    mode: local

    source:
      type: local
      path: ./skills/my-code-review

    integrity: sha256:c84b921...
```

作用：

```text
Detect Local Change
```

---

# 53. Forked Lock Entry

```yaml
skills:
  frontend-design:

    mode: forked

    source:
      type: local
      path: ./skills/frontend-design

    integrity: sha256:local-current...

    upstream:
      source:
        type: github
        repo: anthropics/skills
        path: skills/frontend-design

      baseRevision: ab12cd34...

      baseIntegrity: sha256:base...

      latestRevision: ab12cd34...
```

---

# 54. Fork Base

Fork 必须保存：

```text
Base Revision
```

否则无法正确执行：

```text
3-way Merge
```

因此：

```yaml
baseRevision:
```

是 Forked Lock Entry 的 Required Field。

---

# 55. Base Content

仅保存：

```text
baseRevision
```

未必足够。

如果 Upstream 未来：

```text
Force Push
Delete Commit
Repository Removed
```

Base 内容可能无法重新获取。

所以可以考虑两种实现。

---

# 56. Base Strategy A

只记录：

```text
revision
integrity
```

需要 merge 时重新从 upstream 获取 Base。

优点：

```text
Cache 小
Repository 干净
```

缺点：

```text
Base 可能不可恢复
```

---

# 57. Base Strategy B

Skillbox Runtime Cache 永久保留 Fork Base Snapshot。

例如：

```text
~/.skillbox/library/bases/
```

但换设备后仍然会丢失。

---

# 58. Recommended Fork Base Strategy

推荐：

> Fork 创建时，将 Base Snapshot 隐式保存在 Git Repository 中。

但不要放入用户直接浏览的：

```text
skills/
```

可以使用：

```text
.skillbox/bases/
```

例如：

```text
.skillbox/
└── bases/
    └── react-best-practices/
        └── 07a81df/
```

这样：

```text
Fork
+
Git Repository
=
完整可恢复的 3-way Merge Base
```

---

# 59. Repository Internal Metadata

因此 Repository 可允许：

```text
.skillbox/
```

目录。

例如：

```text
.skillbox/
├── bases/
└── metadata/
```

注意与：

```text
~/.skillbox/
```

区别。

前者：

```text
Repository Metadata
```

后者：

```text
Machine Runtime Data
```

---

# 60. Fork Base Policy

建议：

> Forked Skill 的 Base Snapshot 默认进入 Repository。

理由：

- 可以跨设备 Merge
- 不依赖 Upstream 永久存在
- 保证 Fork 语义完整
- Base 通常体积有限

这是一种：

```text
Conditional Vendoring
```

只保存真正需要的历史内容。

---

# 61. Vendored Lock Entry

```yaml
skills:
  frontend-design:

    mode: vendored

    source:
      type: local
      path: ./skills/frontend-design

    integrity: sha256:xxxx
```

没有：

```yaml
upstream:
```

---

# 62. Integrity

所有 Skill 推荐拥有：

```text
Integrity Hash
```

标准格式：

```text
sha256:<hex>
```

例如：

```text
sha256:bb95d844...
```

---

# 63. What Integrity Covers

Integrity 应覆盖：

> Skill Package 的逻辑文件树。

而不是：

```text
ZIP Bytes
Git Metadata
mtime
ctime
```

---

# 64. Canonical Hash Algorithm

建议算法：

1. 扫描 Skill Directory。
2. 忽略 Skillbox Runtime Metadata。
3. 获取所有文件 Relative Path。
4. 将 Relative Path 转换为 `/` Separator。
5. 按 UTF-8 Byte Order 排序。
6. 对每个文件计算 Content SHA-256。
7. 构建 Canonical Manifest。
8. 对 Canonical Manifest 再 SHA-256。

---

# 65. Canonical Manifest

概念：

```text
SKILL.md\0<hash>\n
references/foo.md\0<hash>\n
scripts/setup.sh\0<hash>\n
```

然后：

```text
sha256(canonical manifest)
```

---

# 66. Line Ending Policy

这是跨平台非常重要的问题。

推荐：

> 默认对文件原始 bytes Hash，不主动转换 CRLF/LF。

但是：

Git checkout 在 Windows 可能自动：

```text
LF → CRLF
```

导致 Integrity 不一致。

因此需要明确策略。

---

# 67. Recommended Line Ending Policy

Repository 中强制：

```text
text eol=lf
```

通过：

```text
.gitattributes
```

例如：

```gitattributes
* text=auto eol=lf
```

对：

```text
SKILL.md
*.md
*.yaml
*.json
*.sh
```

统一 LF。

---

# 68. Binary Files

Binary 文件：

> Hash 原始 bytes。

不要做 Normalize。

---

# 69. File Mode

第一版 Integrity 建议：

> 不包含普通文件权限位。

但可以包含：

```text
Executable bit
```

因为：

```text
scripts/setup.sh
```

是否 executable 可能影响行为。

如果实现困难，第一版可以：

> 文件内容 Hash + path。

然后在 Spec Version 2 再引入 mode。

---

# 70. Integrity Mismatch

Managed Skill：

```text
downloaded integrity
!=
skillbox.lock integrity
```

必须：

```text
Abort Install
```

错误：

```text
INTEGRITY_MISMATCH
```

除非用户显式执行：

```text
skillbox update
```

更新 Lockfile。

---

# 71. Local Modification Detection

Local / Forked / Vendored：

运行：

```text
Current Integrity
```

与：

```text
Locked Integrity
```

比较。

不同：

```text
status = modified
```

---

# 72. Skill Status

标准 Status：

```ts
type SkillStatus =
  | 'ready'
  | 'modified'
  | 'outdated'
  | 'conflict'
  | 'missing'
  | 'broken'
```

---

# 73. ready

表示：

```text
Runtime State
=
Resolved State
```

没有检测到变化。

---

# 74. modified

表示：

> Repository / Local Skill 内容与当前 Lock Entry 不一致。

常见：

```text
用户编辑 SKILL.md
```

---

# 75. outdated

表示：

> 已检测到新的 Upstream Revision。

例如：

```text
Locked:
07a81df

Latest:
a91c823
```

---

# 76. conflict

表示：

```text
Forked Skill
+
Upstream update
+
Merge Conflict
```

或 Skillbox Repository 状态存在未解决冲突。

---

# 77. missing

Manifest 中存在 Skill，但：

```text
Local Source Missing
```

或者 Managed Skill Runtime 没有被 Materialize。

---

# 78. broken

例如：

```text
Invalid SKILL.md

Corrupted directory

Integrity impossible to calculate

Unsupported structure
```

---

# 79. Skill Identity

必须区分：

```text
Alias
Source Identity
Package Identity
```

---

# 80. Alias

Manifest Key：

```text
react-best-practices
```

属于：

> 当前 Repository 的 Logical ID。

---

# 81. Source Identity

例如：

```text
github:vercel-labs/agent-skills:skills/react-best-practices
```

表示：

> Upstream 来源。

---

# 82. Content Identity

通过：

```text
Integrity Hash
```

表示：

> 精确内容。

---

# 83. Why Separate Identity

两个不同 Source：

```text
repo-a/foo
repo-b/foo
```

可能内容完全一样。

Content Identity 相同，但 Source Identity 不同。

反之：

同一 Source：

```text
repo-a/foo
```

不同 Revision：

Content Identity 不同。

因此不能只使用：

```text
name
```

作为全局唯一标识。

---

# 84. Agent Runtime Naming

Agent Skills Directory 中通常需要目录名。

默认使用：

```text
Skill Alias
```

例如：

```text
~/.claude/skills/react-best-practices
```

这样用户可以自定义别名。

---

# 85. Alias Collision

如果两个来源：

```text
foo/react
bar/react
```

用户要同时安装，则 Manifest 必须使用不同 alias：

```yaml
skills:

  foo-react:
    source: ...

  bar-react:
    source: ...
```

---

# 86. State Transition

合法 State Transition：

```text
Remote Install
     │
     ▼
  Managed
```

---

# 87. Managed → Forked

触发：

```text
用户编辑 Managed Skill
```

或者：

```bash
skillbox fork <skill>
```

操作：

1. Materialize Managed 当前版本。
2. Copy 到 Repository `skills/<alias>`.
3. 保存 Upstream Source。
4. 保存 Base Revision。
5. 保存 Base Snapshot。
6. 更新 Manifest。
7. 更新 Lockfile。
8. Reconcile Runtime。

---

# 88. Managed → Vendored

触发：

```bash
skillbox vendor <skill>
```

操作：

1. Copy 当前 Managed Skill 到 Repository。
2. Source 改为 Local。
3. Mode 改为 Vendored。
4. 清除 Active Upstream。
5. 更新 Lockfile。
6. Reconcile。

---

# 89. Forked → Vendored

允许：

```text
Forked
↓
Vendor
↓
Vendored
```

操作：

> 停止 Upstream Tracking。

可以删除：

```text
upstream
base metadata
```

但建议可选保留历史 provenance。

---

# 90. Vendored → Managed

默认：

> 不提供自动转换。

因为无法保证本地内容等于某个 Remote Revision。

用户可以：

```text
remove
+
reinstall
```

或者未来：

```bash
skillbox relink-upstream
```

---

# 91. Local → Managed

不允许自动转换。

需要显式：

```text
publish
```

或：

```text
replace source
```

---

# 92. Managed Edit Semantics

这是重要规范。

Managed Skill 的 Runtime 文件原则上：

> 应尽可能 Read-only from Skillbox perspective。

用户通过：

```text
skillbox edit
```

编辑 Managed 时：

自动执行：

```text
Managed → Forked
```

---

# 93. External Edit Detection

但用户可能直接打开：

```text
~/.skillbox/library/managed/foo/SKILL.md
```

修改。

Skillbox Scan 时：

```text
Integrity != Lock
```

应标记：

```text
modified unmanaged runtime
```

建议提示：

```text
Managed skill was modified outside Skillbox.

[Convert to Fork]
[Restore Upstream Version]
```

不要静默覆盖。

---

# 94. Update Semantics

Managed：

```text
latest revision
>
locked revision
```

可以：

```bash
skillbox update foo
```

更新。

流程：

```text
Resolve Latest
↓
Download
↓
Scan
↓
Verify
↓
Update Lock
↓
Materialize Runtime
```

---

# 95. Forked Update Semantics

Forked：

不能直接：

```text
replace local content
```

必须：

```text
Base
Local
Latest Upstream
```

执行 Merge。

---

# 96. Fork Merge Input

三方：

```text
BASE
=
fork created / last merged upstream snapshot

LOCAL
=
current repository skill

UPSTREAM
=
new resolved upstream
```

---

# 97. Successful Merge

Merge 无冲突：

1. 更新 Local Skill。
2. `baseRevision = latestRevision`
3. Base Snapshot 替换为最新 Upstream。
4. Local Integrity 更新。
5. Status = ready 或 modified，取决于定义。

建议：

> Merge 完成后仍然是 Forked，但不是 Outdated。

---

# 98. Merge Conflict

如果冲突：

```text
status = conflict
```

禁止自动更新：

```text
baseRevision
```

直到冲突解决完成。

---

# 99. Ignore Upstream Update

用户可以：

```text
Ignore this revision
```

是否写入 Lockfile？

建议加入：

```yaml
upstream:
  ignoredRevisions:
    - a91c823
```

但第一版可以不实现。

---

# 100. Pinning

Manifest 可以允许：

```yaml
source:
  type: github
  repo: foo/bar
  ref: v1.2.0
```

表示用户 Intent Pin。

`skillbox update`：

> 不应自动越过 Manifest Pin。

---

# 101. Floating Ref

例如：

```yaml
ref: main
```

允许：

```text
skillbox update
```

重新解析最新 commit。

---

# 102. No Ref

Remote Source 未提供 ref：

Provider 定义默认。

例如 GitHub Provider：

```text
default branch HEAD
```

但 Lockfile 必须记录：

```text
resolved commit
```

---

# 103. Install Modes

安装一个 Remote Skill：

```bash
skillbox add ...
```

默认：

```text
managed
```

除非用户指定：

```bash
skillbox add ... --vendor
```

未来也可以：

```bash
--fork
```

---

# 104. Repository-owned Files

默认进入 Git 的文件：

```text
skillbox.yaml
skillbox.lock
.skillboxignore
skills/
.skillbox/bases/
```

---

# 105. Runtime-only Files

禁止进入 Repository：

```text
~/.skillbox/cache
~/.skillbox/tmp
~/.skillbox/state
~/.skillbox/logs
```

---

# 106. .skillboxignore

作用：

> 控制 Skillbox 在导入、同步、扫描、备份 Skill 内容时忽略什么。

示例：

```gitignore
.env
*.pem
*.key

private/
secrets/

references/internal/
```

---

# 107. .skillboxignore Semantics

语法推荐：

> 与 `.gitignore` Pattern 尽可能兼容。

例如：

```text
foo/
*.key
!important.key
```

第一版可以使用成熟 ignore parser。

---

# 108. .skillboxignore vs .gitignore

`.skillboxignore`：

```text
Skillbox 不应该把这些内容视为 Skill Package 的一部分
```

`.gitignore`：

```text
Git 不跟踪这些文件
```

两者可以不同。

---

# 109. Integrity and Ignored Files

`.skillboxignore` 中匹配的文件：

> 不参与 Skill Integrity。

否则：

```text
ignored secret
```

仍然会导致 hash 变化但又不进入 Git，造成恢复困难。

---

# 110. Mandatory Files

一个合法 Skill 至少应该包含：

```text
SKILL.md
```

如果当前 Agent Skills 规范允许其他主文件，未来 Provider/Validator 可以扩展。

第一版标准：

```text
SKILL.md required
```

---

# 111. Skill Directory Example

```text
my-skill/
│
├── SKILL.md
├── scripts/
│   └── check.sh
│
├── references/
│   └── examples.md
│
└── assets/
    └── diagram.png
```

---

# 112. Path Safety

任何 Skill Source 内文件路径都必须满足：

```text
relative path
```

禁止：

```text
../
absolute path
drive-qualified path
```

避免：

```text
Path Traversal
```

---

# 113. Symlink Inside Skills

远程 Skill 包含 Symlink 时需要严格处理。

第一版推荐：

> 默认拒绝指向 Skill Directory 外部的 Symlink。

例如：

```text
scripts/foo
→ ../../../../etc/passwd
```

必须拒绝。

---

# 114. External Symlink Rule

任何 Materialized Skill 中：

```text
resolved symlink target
```

必须仍在 Skill Root 内。

否则：

```text
UNSAFE_SYMLINK
```

---

# 115. Special Files

默认拒绝：

```text
device files
sockets
named pipes
```

只接受：

```text
regular files
directories
safe symlinks
```

---

# 116. Executable Scripts

Skill 可以包含 executable script。

Lockfile 可以未来记录：

```yaml
files:
  scripts/setup.sh:
    executable: true
```

第一版不强制逐文件记录。

---

# 117. Security Metadata

Lockfile 可以保存安全扫描结果摘要：

```yaml
security:
  risk: medium
  scannedAt: 2026-08-09T00:00:00Z
```

但：

> Security Metadata 不应影响 Content Identity。

---

# 118. Timestamps

为了 Deterministic Lockfile，尽量不要保存：

```text
installedAt
updatedAt
```

因为这会导致每次 install 都修改 Lockfile。

如果需要 UI 显示：

> 放入 Runtime State。

因此第一版 Lockfile 应避免 timestamp。

---

# 119. Deterministic Lockfile

给定：

```text
相同 Manifest
相同 Upstream
相同 Resolution
```

应该产生字节级尽可能稳定的：

```text
skillbox.lock
```

---

# 120. Lockfile Ordering

建议：

- Skill Alias 字典序
- Object Key 固定顺序
- Arrays 保留语义顺序或排序

Agents 建议：

```text
字典序
```

避免 UI 操作顺序导致无意义 Diff。

---

# 121. YAML Serialization

推荐：

```text
2-space indentation
UTF-8
LF
No tabs
```

---

# 122. Comments

Manifest：

> 应尽量保留用户 Comments。

Lockfile：

> 不需要保留 Comments。

因此实现 Manifest Parser 时应考虑：

```text
Comment-preserving YAML
```

但 MVP 可以暂时采用重写。

---

# 123. Environment Variables in Manifest

第一版不建议支持：

```yaml
repo: ${MY_REPO}
```

因为会破坏：

```text
Reproducibility
```

Machine-specific Private Repo Authentication 应交给 GitHub Integration、Git 或 Environment，而不是 Manifest 替换。

---

# 124. Private Repositories

Manifest 可以：

```yaml
source:
  type: git
  url: git@github.com:company/private-skills.git
```

但：

> 凭证绝不能进入 Manifest 或 Lockfile。

Authentication 使用：

```text
Skillbox GitHub App + OS Credential Store
SSH Agent
Git Credential Manager
Environment Credential Provider
```

---

# 125. Secret Fields

禁止：

```yaml
token:
password:
apiKey:
```

作为标准 Source 字段。

如果 Provider 未来需要 Authentication：

> 使用 Machine-local Credential Store。

---

## 125.1 GitHub Connection State

GitHub connection 是机器本地运行状态，不属于可移植 Repository 状态。

允许在全局 config 保存：

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

以下字段禁止进入 config、Manifest、Lockfile、Git remote、日志或 debug bundle：

```text
accessToken
refreshToken
clientSecret
deviceCode
temporaryGitCredential
```

Access token、refresh token 及 token expiry 只能存入 OS Credential Store。

---

## 125.2 GitHub Authorization

默认 GitHub Provider 必须使用适用于 CLI / native client 的 Device Flow。发行包可以包含 GitHub App Client ID，但不得包含 Client Secret。

授权状态至少包括：

```text
not-connected
authorizing
connected
refresh-required
reauthorization-required
```

轮询必须处理 authorization pending、slow down、expired code、access denied 和网络错误。取消授权不得改变本地 Repository 内容。

---

## 125.3 Repository Binding

GitHub 连接完成后可以：

```text
Create new repository
Select existing repository
Skip sync
Use advanced Git remote
```

新建 Repository 默认必须为 Private，除非用户显式选择 Public。Repository binding 保存普通 HTTPS URL 或用户提供的 Git URL，绝不内嵌 token。

创建与首次同步必须可重试并保持幂等。重复执行不得重复创建 GitHub Repository、重复添加 origin 或覆盖未提交内容。

---

## 125.4 Git Credential Resolution

Git transport 的凭证解析优先级：

```text
1. Connected Skillbox GitHub App credential
2. Existing gh / system Git credential
3. User-configured HTTPS / SSH remote
```

Skillbox GitHub credential 只能通过临时 credential helper、标准输入或等价的进程级安全通道提供给系统 Git。不得出现在命令行参数、进程标题、remote URL 或持久化 Git config 中。

---

## 125.5 Disconnect Semantics

`Disconnect GitHub` 必须：

```text
删除 OS Credential Store 中的 GitHub token
清除本机 GitHub connection metadata
尽力撤销 Provider session when supported
```

它不得：

```text
删除本地 Repository
删除 GitHub Repository
删除用户 Skills
自动移除 Git remote
```

---

## 125.6 Sync Provider Scope

V0.2 Provider 范围：

```text
GitHubRepositoryProvider   Default
GenericGitProvider         Advanced
GistProvider               Out of scope
```

Secret Gist 不得被描述为 private backup。

---

# 126. Agent Configuration

Top-level：

```yaml
agents:
```

可以保存 Repository 级 Agent 配置。

例如：

```yaml
agents:

  claude:
    enabled: true

  codex:
    enabled: true

  cursor:
    enabled: false
```

---

# 127. Per-agent Settings

第一版尽量避免写：

```yaml
skillDirectory:
```

因为它是 Machine-specific。

允许 Portable 配置：

```yaml
agents:
  claude:
    enabled: true
```

---

# 128. Agent Path Overrides

路径 Override 必须存在：

```text
~/.skillbox/config.json
```

例如：

```json
{
  "agents": {
    "claude": {
      "skillDirectories": [
        "/custom/path"
      ]
    }
  }
}
```

不进入 Repository。

---

# 129. Reconcile Definition

Reconcile 输入：

```text
Manifest
Lockfile
Repository Files
Machine Config
Detected Agents
```

输出：

```text
Runtime Library
Agent Assignments
```

---

# 130. Reconcile Must Be Idempotent

连续执行：

```bash
skillbox install
skillbox install
skillbox install
```

如果没有任何输入变化：

> 不应该持续产生文件变更。

---

# 131. Reconcile Rule

对于 Manifest 每个 Skill：

```text
Resolve Desired Entry
↓
Read Locked Entry
↓
Ensure Content Available
↓
Verify Integrity
↓
Materialize Runtime
↓
Assign Agents
```

最后：

```text
Remove stale managed runtime entries
Remove stale agent links
```

但删除前必须注意：

> 不要删除用户未知的 Agent Skills。

---

# 132. Ownership Marker

为了避免 Skillbox 删除不是自己管理的 Skill，Agent Link 需要记录 Ownership。

Runtime State：

```text
~/.skillbox/state/links.json
```

记录：

```text
哪些 Agent Skill 是 Skillbox 创建的
```

Reconcile 只能自动清理：

```text
Skillbox-owned link
```

---

# 133. Existing External Skills

如果检测到：

```text
~/.claude/skills/foo
```

不是 Skillbox 管理的。

显示：

```text
External Skill
```

用户可以：

```text
Import
Ignore
```

不要直接接管。

---

# 134. Import Semantics

用户执行：

```text
Import Existing Skill
```

可以选择：

```text
Local
Managed
```

但如果来源未知：

> 默认 Import 为 Local。

因为无法安全推断 upstream。

---

# 135. Source Detection

未来可以根据：

```text
Git metadata
Skill metadata
Origin metadata
```

尝试识别 Upstream。

但：

> 不应该仅靠同名猜测 Source。

---

# 136. Restore

新设备：

```bash
git clone ...

npx skillbox install
```

处理：

```text
Read Manifest
↓
Read Lockfile
↓
Verify Schema
↓
Restore Local/Forked/Vendored
↓
Fetch Managed
↓
Verify Integrity
↓
Detect Agents
↓
Assign
```

---

# 137. Missing Remote Source

如果 Managed Skill 的 Locked Revision 已经无法获取：

```text
RESTORE_FAILED_SOURCE_UNAVAILABLE
```

不能偷偷安装 Latest。

否则破坏：

```text
Reproducibility
```

---

# 138. Optional Fallback Snapshot

未来可以提供：

```bash
skillbox freeze
```

把所有 Managed Skill Snapshot 保存进 Repository。

相当于：

```text
Full Vendoring Snapshot
```

但默认不启用。

---

# 139. Offline Restore

默认：

```text
Managed Skills
```

需要网络或现有 Cache。

如果用户需要完全离线恢复：

```text
freeze / vendor
```

是更合理方案。

---

# 140. Lockfile Missing

如果：

```text
skillbox.yaml exists
skillbox.lock missing
```

执行：

```bash
skillbox install
```

可以：

1. Resolve 所有 Remote Source。
2. 生成新的 Lockfile。
3. Install。

但这不保证与历史环境相同。

CLI 应提示：

```text
No lockfile found. Resolving current upstream versions.
```

---

# 141. Frozen Install

提供：

```bash
skillbox install --frozen-lockfile
```

语义类似 pnpm。

要求：

```text
Manifest 与 Lockfile 一致
```

并禁止修改：

```text
skillbox.lock
```

---

# 142. CI Mode

未来：

```bash
skillbox install --ci
```

等价：

```text
--frozen-lockfile
--no-interactive
```

并在：

```text
security violation
integrity mismatch
schema mismatch
```

时直接失败。

---

# 143. Manifest / Lock Mismatch

例如 Manifest 新增：

```text
foo
```

但 Lockfile 没有。

普通：

```bash
skillbox install
```

可以更新 Lockfile。

Frozen：

```bash
skillbox install --frozen-lockfile
```

必须失败：

```text
LOCKFILE_OUTDATED
```

---

# 144. Remove Semantics

```bash
skillbox remove foo
```

需要：

1. 从 Manifest 删除。
2. 从 Lockfile 删除。
3. 删除 Skillbox Agent Links。
4. 删除 Runtime Materialization。
5. 对 Repository Full Copy 根据 Mode 决定。

---

# 145. Remove Local/Forked/Vendored

因为完整文件属于用户 Repository。

默认不应无提示删除。

建议：

```text
Remove skill from Skillbox?

[Remove config only]
[Remove config and files]
[Cancel]
```

CLI 非交互模式：

```bash
--delete-files
```

才删除文件。

---

# 146. Managed Remove

Managed 没有 Repository Full Copy。

可以直接：

```text
Remove Manifest
Remove Lock Entry
Remove Runtime
Remove Agent Links
```

---

# 147. Rename Alias

未来支持：

```bash
skillbox rename foo bar
```

需要同步：

```text
Manifest Key
Lock Key
Runtime Alias
Agent Links
Local Directory optional
```

第一版可以不提供。

---

# 148. Compatibility

Manifest Version：

```text
version: 1
```

客户端：

如果支持：

```text
1
```

正常读取。

如果文件：

```text
version: 2
```

而客户端只支持 1：

必须：

```text
UNSUPPORTED_MANIFEST_VERSION
```

不能尝试写回。

---

# 149. Unknown Fields

同一 Schema Version 内：

> Reader 应尽量忽略并保留 Unknown Fields。

为了未来扩展。

Writer 不应无理由删除未知字段。

这要求未来 Parser 支持：

```text
Round-trip preservation
```

---

# 150. Lockfile Unknown Fields

Reader：

> 可以忽略 Unknown Fields。

Writer：

> 允许重新生成并丢弃非标准 Unknown Fields。

因为 Lockfile 属于 Machine-generated。

---

# 151. Schema Migration

Manifest Schema 升级：

```bash
skillbox migrate
```

应该：

1. Backup。
2. Validate current.
3. Convert.
4. Write atomically.
5. Report changes.

---

# 152. Complete Manifest Example

```yaml
version: 1

name: personal-agent-skills

description: Shared AI coding skills across my devices

settings:
  defaultAgents:
    - claude
    - codex

skills:

  react-best-practices:

    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
      ref: main

    mode: managed

  my-code-review:

    source:
      type: local
      path: ./skills/my-code-review

    mode: local

  frontend-design:

    source:
      type: local
      path: ./skills/frontend-design

    mode: forked

    upstream:
      type: github
      repo: anthropics/skills
      path: skills/frontend-design
      ref: main

    agents:
      - claude

  legacy-backend:

    source:
      type: local
      path: ./skills/legacy-backend

    mode: vendored

    agents:
      - codex

agents:

  claude:
    enabled: true

  codex:
    enabled: true
```

---

# 153. Complete Lockfile Example

```yaml
lockfileVersion: 1

generatedBy: skillbox@0.4.0

skills:

  frontend-design:

    mode: forked

    source:
      type: local
      path: ./skills/frontend-design

    integrity: sha256:4d9268e01234

    upstream:

      source:
        type: github
        repo: anthropics/skills
        path: skills/frontend-design

      baseRevision: 5ed812ff981a
      baseIntegrity: sha256:a193fab02199
      latestRevision: 5ed812ff981a

  legacy-backend:

    mode: vendored

    source:
      type: local
      path: ./skills/legacy-backend

    integrity: sha256:b319bc129982

  my-code-review:

    mode: local

    source:
      type: local
      path: ./skills/my-code-review

    integrity: sha256:879db391bd19

  react-best-practices:

    mode: managed

    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices

    revision: 07a81df7a84e9174
    integrity: sha256:73b9173fd810
```

---

# 154. Repository Example

```text
personal-agent-skills/
│
├── skillbox.yaml
├── skillbox.lock
├── .skillboxignore
├── .gitignore
├── .gitattributes
│
├── skills/
│   │
│   ├── my-code-review/
│   │   └── SKILL.md
│   │
│   ├── frontend-design/
│   │   ├── SKILL.md
│   │   └── references/
│   │
│   └── legacy-backend/
│       └── SKILL.md
│
└── .skillbox/
    └── bases/
        └── frontend-design/
            └── 5ed812ff981a/
                ├── SKILL.md
                └── references/
```

Managed：

```text
react-best-practices
```

没有完整出现在：

```text
skills/
```

中。

---

# 155. Recommended .gitattributes

```gitattributes
* text=auto eol=lf

*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.pdf binary
*.zip binary
```

目的是：

> 减少跨 Windows/macOS/Linux 的 Integrity 差异。

---

# 156. Recommended .gitignore

Repository 内可以：

```gitignore
.DS_Store
Thumbs.db

*.log

.skillbox/tmp/
```

但：

```text
.skillbox/bases/
```

不能忽略。

---

# 157. Runtime Example

macOS：

```text
~/.skillbox/
│
├── config.json
│
├── cache/
├── library/
│   ├── react-best-practices/
│   ├── my-code-review/
│   ├── frontend-design/
│   └── legacy-backend/
│
├── state/
│   └── links.json
│
├── tmp/
└── logs/
```

Claude：

```text
~/.claude/skills/
│
├── react-best-practices
│   -> ~/.skillbox/library/react-best-practices
│
└── my-code-review
    -> ~/.skillbox/library/my-code-review
```

---

# 158. Machine Config

例如：

```json
{
  "repository": "/Users/user/Documents/my-agent-skills",

  "linkStrategy": "auto",

  "web": {
    "host": "127.0.0.1",
    "port": 43821,
    "openBrowser": true
  },

  "agents": {}
}
```

该文件：

```text
不进入 Git。
```

---

# 159. Security Rules

Remote Skill 在进入 Runtime 前必须至少：

```text
Path Safety Check
Structure Validation
Integrity Validation
```

安全 Scanner 可以是：

```text
Optional Warning Layer
```

但以下必须硬阻止：

```text
Path Traversal
Unsafe External Symlink
Integrity Mismatch
Unsupported Special File
```

---

# 160. Secret Scan

Secret Scan 属于：

```text
Git Sync Policy
```

而不是 Skill Package Identity。

因此 Secret Scan 结果不进入 Integrity。

---

# 161. Spec Invariants

实现必须保持以下不变量。

### Invariant 1

Managed Skill 的 Repository 不要求保存完整 Upstream 文件。

### Invariant 2

Forked Skill 必须有：

```text
Local Source
+
Upstream Source
+
Base Revision
```

### Invariant 3

Local/Vendored 必须使用 Portable Local Path。

### Invariant 4

Machine Absolute Path 不得写入 Manifest / Lockfile。

### Invariant 5

Lockfile Remote Source 必须尽可能解析到 Immutable Revision。

### Invariant 6

Integrity 必须基于稳定 Canonical Representation。

### Invariant 7

Reconcile 必须幂等。

### Invariant 8

Skillbox 不得删除非 Skillbox-owned Agent Files。

### Invariant 9

Managed Integrity Mismatch 必须失败。

### Invariant 10

Forked Skill Upstream Update 不得静默覆盖 Local Changes。

---

# 162. Recommended CLI-to-Spec Mapping

```text
skillbox add
→ Manifest add
→ Resolve
→ Lock add
→ Reconcile
```

```text
skillbox update
→ Resolve latest
→ Lock update
→ Reconcile
```

```text
skillbox fork
→ Remote/Managed → Local/Forked
→ Save Base
→ Manifest update
→ Lock update
```

```text
skillbox vendor
→ Localize
→ Remove active upstream
→ Lock update
```

```text
skillbox install
→ Manifest + Lock → Runtime
```

```text
skillbox sync
→ Repository Sync + Reconcile
```

```text
skillbox github connect
→ Device authorization
→ Credential Store
→ Current user
```

```text
skillbox github create
→ Create private repository by default
→ Bind ordinary HTTPS remote
→ Initial commit + push
```

```text
skillbox github disconnect
→ Delete local credentials and connection metadata
→ Preserve local and remote repositories
```

---

# 163. MVP Specification Scope

V0.1 必须实现：

```text
Manifest v1

Lockfile v1

Local Source

GitHub Source

Managed Mode

Local Mode

Agent Assignment

Integrity

Reconcile
```

---

# 164. V0.2 Specification Scope

加入：

```text
Git Source

Git Sync

GitHub App Device Flow

GitHub Connection State

OS Credential Store

Repository Create / Select / Bind

Temporary Git HTTPS Credential

Token Refresh / Reauthorization

Disconnect Semantics

Secret Scan

Cross-device Restore

Frozen Lockfile
```

---

# 165. V0.3 Specification Scope

加入：

```text
Registry Source

Remote Update

Outdated Status

Security Metadata
```

---

# 166. V0.4 Specification Scope

加入：

```text
Forked Mode

Vendored Mode

Base Snapshot

3-way Merge

Conflict Status
```

---

# 167. Deferred Specification

暂不进入 Version 1：

```text
MCP

Rules

Hooks

Profiles

Team Permissions

Cloud State

Signed Skills

Remote Lock Registry

Peer Dependencies

Skill Dependencies

Lifecycle Hooks
```

尤其：

> 第一版不要急着给 Skill 加复杂 Dependency Graph。

先把：

```text
Source
Version
Ownership
Sync
Agent Assignment
```

做稳定。

---

# 168. Future Skill Dependencies

如果未来 Skill 之间需要 Dependency，可以扩展：

```yaml
skills:

  foo:
    dependencies:
      - bar
```

但这会显著提高：

```text
resolver
cycle detection
version conflict
```

复杂度。

因此不属于 MVP。

---

# 169. Future Signed Skills

未来可以增加：

```yaml
signature:
```

或：

```text
Sigstore
GitHub Attestation
```

验证 Skill 来源。

但当前：

```text
revision
+
integrity
+
security scan
```

已经足够作为第一阶段。

---

# 170. Specification Philosophy

Skillbox Spec 应尽量借鉴成熟包管理器的经验：

```text
package.json
+
pnpm-lock.yaml
+
Git
```

但避免复制传统 Package Manager 所有复杂能力。

Agent Skills 与传统 npm Package 最大不同：

> 用户极有可能直接编辑第三方 Skill。

因此 Skillbox Spec 必须把：

```text
Fork
Ownership
Upstream
Merge
```

作为一等公民。

---

# 171. Final Model

整个协议最终可以浓缩成：

```text
                skillbox.yaml
                  Desired
                     │
                     ▼
                skillbox.lock
                  Resolved
                     │
                     ▼
               Runtime Library
                  Installed
                     │
                     ▼
            ┌────────┼────────┐
            ▼        ▼        ▼
         Claude    Codex    Cursor
```

第三方 Skill：

```text
Remote
  │
  ▼
Managed
  │
  ├──── Edit ────→ Forked
  │                  │
  │                  └── Track + Merge Upstream
  │
  └──── Vendor ──→ Vendored
```

用户 Skill：

```text
Create
  │
  ▼
Local
```

Git Repository：

```text
Manifest
+
Lockfile
+
Local Source
+
Forked Source
+
Vendored Source
+
Fork Base Snapshot
```

从而实现：

> **Git-backed but not Git-dumped.**

最终核心目标：

```text
Same Repository
+
Same Lockfile
+
Skillbox
=
Equivalent Agent Skills Environment
```
