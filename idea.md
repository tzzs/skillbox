下面我把前面讨论的内容整理成一份可以直接交给其他 Agent、开发者或放进项目 README / PRD 的完整 Markdown。

# Agent Skills Manager / Skillbox 产品方案

## 1. 项目背景

随着 Claude Code、OpenAI Codex、Cursor、Gemini CLI、OpenCode 等 AI Agent 工具逐渐开始支持 Agent Skills，用户会越来越多地面临以下问题：

- 不同 Agent 的 Skills 存储目录不同
- 同一个 Skill 需要在多个 Agent 之间重复安装
- 多台设备之间难以同步 Skills
- 第三方 Skill 安装后缺乏统一的版本管理
- 用户修改第三方 Skill 后，很难继续跟踪 upstream 更新
- Skills 数量增加后，纯文件管理体验较差
- 缺少统一的可视化增删改查能力
- 缺少 Git 版本控制、Diff、Rollback、Merge 等能力
- 第三方 Skill 可能包含危险脚本、Secrets 引用等安全风险

因此计划开发一个：

> **Local-first、Git-native、跨 Agent 的 Skills Package Manager。**

暂定项目名：

```text
Skillbox
```

核心理念：

> One command to manage every skill, for every agent.

启动方式：

```bash
npx skillbox
```

Skillbox 不应该只是一个“Skills 文件夹管理 GUI”，而应该更接近：

```text
pnpm
+
Git
+
dotfiles manager
+
localhost dashboard
```

即：

> **Agent Skills 的包管理器、同步器、版本管理器和可视化控制台。**

---

# 2. 产品定位

Skillbox 的主要定位：

```text
Local-first Agent Skills Package Manager
```

主要解决：

```text
安装
管理
同步
编辑
版本控制
更新
Fork
Diff
Merge
安全检查
跨 Agent 分发
跨设备同步
```

相比传统桌面 Skills Manager，Skillbox 更强调：

```text
npx
+
CLI / TUI
+
localhost Web UI
+
Git-native
+
Reproducible Environment
```

因此不要求用户安装一个长期运行的 Electron / Tauri 桌面应用。

用户可以随时运行：

```bash
npx skillbox
```

或者：

```bash
npx skillbox web
```

完成所有管理操作。

---

# 3. 核心产品目标

Skillbox 的第一原则：

> Skill 文件必须仍然属于用户，而不是被某个 SaaS 平台锁定。

因此采用：

```text
Local First
Git as Source of Truth
```

架构。

Skillbox 本身尽量不维护中心化云数据库。

用户的数据主要存在：

```text
本地文件系统
+
用户自己的 GitHub Repository
```

这样可以获得：

- 数据完全可控
- 无厂商锁定
- Git 历史天然可追踪
- 支持 GitHub Private Repository
- 支持多设备同步
- 支持回滚
- 支持 Branch
- 支持 Pull Request
- 支持代码 Review
- 容易备份
- 项目停止维护后，用户数据仍然可用

---

# 4. 核心功能

## 4.1 Agent 自动发现

Skillbox 自动检测当前设备上的 Agent。

例如：

```text
Claude Code
Codex
Cursor
Gemini CLI
OpenCode
Windsurf
GitHub Copilot
其他支持 Skills 的 Agent
```

第一次启动：

```text
Welcome to Skillbox

Detected agents:

✓ Claude Code     12 skills
✓ Codex            8 skills
✓ Cursor           6 skills
○ Gemini CLI       not installed

Import existing skills?

> Import all
  Select manually
  Skip
```

Skillbox 应维护一套 Agent Adapter：

```text
AgentAdapter
├── ClaudeAdapter
├── CodexAdapter
├── CursorAdapter
├── GeminiAdapter
├── OpenCodeAdapter
└── ...
```

每个 Adapter 负责：

```text
detect()
getSkillDirectories()
install()
remove()
link()
unlink()
scan()
```

---

# 5. Skill Library

Skillbox 应建立一个统一的 Canonical Skill Library。

例如：

```text
~/.skillbox/
├── config/
├── cache/
├── repos/
├── library/
└── state/
```

不同 Agent 不应该各自维护完全独立的 Skill 副本。

推荐采用：

```text
Canonical Library
        ↓
symlink / junction / copy
        ↓
Agent Skills Directory
```

例如：

```text
                   Skillbox
                      │
              Canonical Library
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
     Claude         Codex         Cursor
```

Linux / macOS 优先使用：

```text
symlink
```

Windows 优先考虑：

```text
junction
symlink
```

不支持链接时 fallback：

```text
copy
```

---

# 6. Marketplace / Skills Registry

Skillbox 不建议自己重新建立一个 Skills Registry。

可以优先复用现有生态，例如：

```text
skills.sh
GitHub
Well-known sources
Local repositories
```

内部设计 Provider：

```text
RegistryProvider
├── SkillsShProvider
├── GitHubProvider
├── LocalProvider
├── WellKnownProvider
└── FutureProvider
```

这样 Skillbox 不和单一平台绑定。

用户可以：

```bash
skillbox search react
```

或者在 Web UI：

```text
Explore

Search Skills...

Trending
Official
Popular
Recently Updated
Security Reviewed
```

---

# 7. GitHub 同步设计

GitHub 同步是 Skillbox 最核心的能力之一。

不建议采用两种极端方案：

## 方案 A：只保存名称 + 版本

例如：

```yaml
skills:
  - react-best-practices@1.2.0
```

优点：

- 仓库小
- Git 历史干净
- 更新简单

但存在明显问题：

- GitHub Repo / Branch 可能变化
- Tag 可能不存在
- Skill 不一定有标准版本号
- 用户修改不会被保存
- upstream 可能删除 Skill
- 无法保证环境完全可复现

因此不能只记录：

```text
name
version
```

至少应该记录：

```text
repository
path
commit SHA
integrity hash
```

---

## 方案 B：所有 Skill 都完整同步

例如：

```text
skills/
├── react-best-practices/
├── frontend-design/
├── github/
├── pdf/
├── security-review/
└── ...
```

优点：

- 100% 可恢复
- 不依赖 upstream
- 离线可用

但也有明显问题：

- 大量第三方文件进入用户 Git
- Git 历史噪音很大
- upstream 更新造成大量 commit
- 用户自己的 Skill 容易淹没
- 可能涉及第三方 License / Redistribution 问题
- 仓库越来越重

因此也不建议默认完整复制所有第三方 Skill。

---

# 8. 推荐 Git 同步模型

推荐采用：

> **Reference + Lock + Conditional Vendoring**

即：

> 默认只记录第三方 Skill 的精确来源和版本状态；用户自己创建或者修改过的 Skill 保存完整内容。

Skill 分成四种状态：

```text
Managed
Forked
Local
Vendored
```

---

# 9. Managed Skill

Managed Skill 指：

> 来自第三方 upstream，并且用户没有修改。

例如：

```text
vercel-labs/agent-skills
└── react-best-practices
```

Git Repository 中不保存完整 Skill 文件。

只在：

```text
skillbox.yaml
skillbox.lock
```

中记录。

示例：

```yaml
react-best-practices:
  source: github
  repo: vercel-labs/agent-skills
  path: skills/react-best-practices
  revision: 07a81df7
  integrity: sha256:xxxx
  mode: managed
```

本地文件可以缓存在：

```text
~/.skillbox/cache/
```

Agent 使用：

```text
Claude
Codex
Cursor
   ↓
~/.skillbox/cache/react-best-practices
```

特点：

```text
Git 保存完整文件：否
跟踪 upstream：是
支持自动更新：是
```

---

# 10. Forked Skill

当用户修改 Managed Skill 时：

```text
Managed
   ↓
User Edit
   ↓
Forked
```

Skillbox 应自动检测：

```text
Local modifications detected
```

然后提示：

```text
This is a managed upstream skill.

Editing it will create a local fork.

Upstream:
vercel-labs/agent-skills

Current revision:
07a81df7

[Create Fork & Edit]
```

用户确认后：

```text
skills/
└── react-best-practices/
    ├── SKILL.md
    ├── references/
    ├── scripts/
    └── assets/
```

整个 Skill 开始进入 Git。

同时保存 upstream 信息：

```yaml
react-best-practices:
  mode: forked

  upstream:
    repo: vercel-labs/agent-skills
    path: skills/react-best-practices
    revision: 07a81df7

  local:
    path: skills/react-best-practices
```

特点：

```text
Git 保存完整文件：是
跟踪 upstream：是
自动更新：否
支持 Merge：是
```

---

# 11. Local Skill

Local Skill 指：

> 用户自己创建的 Skill。

例如：

```bash
skillbox create my-code-review
```

生成：

```text
skills/
└── my-code-review/
    ├── SKILL.md
    ├── scripts/
    ├── references/
    └── assets/
```

所有内容直接进入 Git。

Manifest：

```yaml
my-code-review:
  mode: local
  path: skills/my-code-review
```

特点：

```text
Git 保存完整文件：是
跟踪 upstream：否
自动更新：否
```

这是完全属于用户自己的 Source Code。

---

# 12. Vendored Skill

用户也可以主动将一个第三方 Skill 变为完全本地维护。

例如：

```bash
skillbox vendor react-best-practices
```

变化：

```text
Managed
   ↓
Vendored
```

完整 Skill 进入：

```text
skills/react-best-practices/
```

但不再跟踪 upstream。

区别：

```text
Forked
=
保存完整文件
+
继续跟踪 upstream

Vendored
=
保存完整文件
+
停止跟踪 upstream
```

特点：

```text
Git 保存完整文件：是
跟踪 upstream：否
自动更新：否
```

---

# 13. 四种 Skill 状态总结

| 类型 | Git 保存完整文件 | 跟踪 Upstream | 自动更新 | 支持 Merge |
|---|---:|---:|---:|---:|
| Managed | 否 | 是 | 是 | 不需要 |
| Forked | 是 | 是 | 否 | 是 |
| Local | 是 | 否 | 否 | 不需要 |
| Vendored | 是 | 否 | 否 | 不需要 |

整个系统应围绕这四种状态设计。

---

# 14. Git Repository 推荐结构

推荐：

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
│   ├── my-code-review/
│   │   └── SKILL.md
│   │
│   ├── my-backend-rules/
│   │   ├── SKILL.md
│   │   └── references/
│   │
│   └── react-best-practices/
│       ├── SKILL.md
│       └── references/
│
└── README.md
```

其中：

```text
skills/
```

默认只存：

```text
Local
Forked
Vendored
```

不保存普通：

```text
Managed
```

Skill。

---

# 15. skillbox.yaml

`skillbox.yaml` 类似：

```text
package.json
```

表达：

> 用户希望安装和启用什么。

它应该是：

```text
Human Editable
Declarative
Version Controlled
```

例如：

```yaml
version: 1

skills:

  react-best-practices:
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices

    agents:
      - claude
      - codex

  frontend-design:
    source:
      type: github
      repo: anthropics/skills
      path: skills/frontend-design

    agents:
      - claude

  my-review:
    source:
      type: local
      path: ./skills/my-review

    agents:
      - claude
      - codex
```

---

# 16. skillbox.lock

`skillbox.lock` 类似：

```text
package-lock.json
pnpm-lock.yaml
```

其作用：

> 精确描述当前 Skill 环境。

例如：

```yaml
lockfileVersion: 1

skills:

  react-best-practices:
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices

    revision: 07a81df7a84e0f8a123456

    integrity: sha256-a72c...

    mode: managed

  frontend-design:
    source:
      type: github
      repo: anthropics/skills
      path: skills/frontend-design

    revision: bb192d31234567

    integrity: sha256-b82e...

    mode: managed
```

这样可以实现：

```text
Reproducible Agent Environment
```

---

# 17. 新设备恢复流程

用户换电脑后：

```bash
git clone git@github.com:user/my-agent-skills.git
```

然后：

```bash
cd my-agent-skills
```

运行：

```bash
npx skillbox install
```

Skillbox：

```text
Reading skillbox.yaml...

Reading skillbox.lock...

Downloading:

✓ react-best-practices @ 07a81df7
✓ frontend-design @ bb192d3

Restoring local skills...

✓ my-code-review
✓ my-backend-rules

Detected Agents:

✓ Claude Code
✓ Codex
✓ Cursor

Linking skills...

✓ Claude Code
✓ Codex

Environment restored successfully.
```

最终用户获得几乎完全一致的环境。

---

# 18. Skill Diff

Diff 应作为 Skillbox 的核心功能之一。

Managed Skill 更新：

```text
Installed:
07a81df7

Latest:
a91c823b

[View Changes]
[Update]
```

普通 Managed Skill 可以直接升级。

---

# 19. Forked Skill Upstream Update

Forked Skill 不能直接覆盖。

假设：

```text
Base
   │
   ├── Local Changes
   │
   └── Upstream Changes
```

Skillbox 应提供：

```text
BASE
LOCAL
UPSTREAM
```

三方 Diff。

界面：

```text
Local modifications:    8
Upstream modifications: 12

[View Diff]
[Merge]
[Ignore]
```

支持：

```text
Keep Local
Use Upstream
Manual Merge
```

最终可以实现：

```text
3-way Merge
```

这将是 Skillbox 相比普通 Skills Manager 非常重要的能力。

---

# 20. Skill 生命周期

推荐生命周期：

```text
          Install
             │
             ▼
          Managed
             │
       ┌─────┴─────┐
       │           │
      Edit       Vendor
       │           │
       ▼           ▼
     Forked     Vendored
       │
       │ Upstream Update
       ▼
      Diff
       │
       ▼
      Merge
```

Local Skill：

```text
Create
  │
  ▼
Local
  │
  ▼
Git Managed
```

---

# 21. Git 同步

提供：

```bash
skillbox sync
```

等价于高级逻辑：

```text
Scan
↓
Detect Changes
↓
Secret Scan
↓
Update Manifest
↓
Update Lockfile
↓
Git Pull
↓
Resolve
↓
Commit
↓
Push
```

也可以拆分：

```bash
skillbox pull
skillbox push
skillbox status
```

---

# 22. GitHub 初始化

支持：

```bash
skillbox git init
```

或者：

```bash
skillbox git connect git@github.com:user/my-skills.git
```

也可以：

```bash
skillbox github create
```

创建：

```text
Private Repository
```

默认建议：

```text
Private
```

而不是 Public。

---

# 23. Secrets 安全设计

因为 Skill 可以包含：

```text
scripts/
references/
assets/
```

用户很容易不小心存入：

```text
API Key
Access Token
Private URL
SSH Key
.env
Credentials
```

所以每次 Git Push 前建议执行：

```text
Pre-Sync Security Scan
```

检测：

```text
.env
*.pem
*.key
id_rsa
OPENAI_API_KEY
ANTHROPIC_API_KEY
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
GITHUB_TOKEN
Bearer Token
Private Key
```

发现后：

```text
Potential secret detected

skills/company-api/reference.md

OPENAI_API_KEY=sk-...

Push blocked.

[Review]
[Ignore Once]
[Add to Ignore]
```

默认：

> **High confidence Secret 应阻止 Push。**

---

# 24. .skillboxignore

提供：

```text
.skillboxignore
```

例如：

```gitignore
.env
secrets/
private/
*.pem
*.key

references/company-internal.md
scripts/private/
```

需要明确：

```text
.skillboxignore
```

控制：

> Skillbox Sync / Backup 行为。

而：

```text
.gitignore
```

控制：

> Git 行为。

两者不要完全等价。

---

# 25. Skill 安全扫描

第三方 Skill 在安装前建议进行安全分析。

包括：

```text
Shell execution
Network access
Filesystem writes
Credential access
Environment variables
SSH access
sudo
curl | bash
rm -rf
PowerShell execution
Executable files
External binaries
```

展示：

```text
Install react-helper?

Source
github.com/foo/react-helper

Security
────────────────────────

✓ No credential access
✓ No SSH access
! Network requests detected
! Contains shell script

Files:

scripts/setup.sh
scripts/install.js

Risk:
MEDIUM

[Review]
[Install]
```

未来可以接：

```text
skills.sh security audit
Socket
Snyk
其他 Scanner
```

---

# 26. TUI

默认执行：

```bash
npx skillbox
```

进入：

```text
┌──────────────────────────────┐
│ Skillbox                     │
│                              │
│ › My Skills                  │
│   Explore                    │
│   Agents                     │
│   Sync GitHub                │
│   Updates                    │
│   Open Web UI                │
│   Settings                   │
│                              │
└──────────────────────────────┘
```

TUI 主要负责：

```text
快速操作
服务器环境
SSH 环境
无 GUI 环境
开发者高级用户
```

---

# 27. Web UI

运行：

```bash
npx skillbox web
```

输出：

```text
Skillbox running

Local:
http://localhost:43821

✓ Claude Code detected
✓ Codex detected
✓ Cursor detected
✓ 27 skills loaded

Opening browser...
```

也支持：

```bash
skillbox web --port 3000
```

以及：

```bash
skillbox web --no-open
```

---

# 28. Web UI 信息架构

推荐：

```text
Skillbox
│
├── Library
├── Explore
├── Updates
├── Agents
├── Git
└── Settings
```

---

# 29. Library

Library 是核心页面。

例如：

```text
My Skills

24 Skills

────────────────────────────────

React Best Practices

Source
vercel-labs/agent-skills

Mode
Managed

Installed Agents
Claude ✓
Codex ✓
Cursor ○

Upstream
Up to date

Security
Low Risk

[Open]
[Update]
[Agents]
[Remove]
```

Forked Skill：

```text
React Best Practices

Mode
Forked

Local modifications
8

Upstream changes
12

[Edit]
[Diff]
[Merge]
```

---

# 30. Explore

展示：

```text
Search
Trending
Official
Popular
Recently Updated
Security Reviewed
```

Skill 页面：

```text
React Best Practices

vercel-labs/agent-skills

────────────────────

Description

Version / Revision

Files

SKILL.md
references/
scripts/

Security

Compatible Agents

Claude
Codex
Cursor

────────────────────

[Install]
```

---

# 31. Agents

页面：

```text
Agents

Claude Code
Detected
12 Skills

Codex
Detected
9 Skills

Cursor
Detected
6 Skills

Gemini CLI
Not Installed
```

点击：

```text
Claude Code
```

显示：

```text
Skills

✓ react-best-practices
✓ frontend-design
✓ my-code-review
○ github
```

用户可以通过 Switch 控制 Skill 是否暴露给某个 Agent。

---

# 32. Git 页面

展示：

```text
Repository

github.com/user/my-agent-skills

Branch
main

Status
3 modified skills

Last Sync
2 min ago
```

操作：

```text
[Pull]
[Commit]
[Push]
[Sync]
```

以及：

```text
Changes

M skills/my-code-review/SKILL.md
M skillbox.lock
A skills/my-new-skill/
```

---

# 33. CLI 设计

推荐尽量接近：

```text
npm
pnpm
git
```

基本命令：

```bash
skillbox
```

进入 TUI。

---

安装：

```bash
skillbox add vercel-labs/agent-skills@react-best-practices
```

---

搜索：

```bash
skillbox search react
```

---

查看：

```bash
skillbox list
```

---

删除：

```bash
skillbox remove react-best-practices
```

---

创建：

```bash
skillbox create my-skill
```

---

编辑：

```bash
skillbox edit my-skill
```

---

更新：

```bash
skillbox update
```

或者：

```bash
skillbox update react-best-practices
```

---

查看可更新：

```bash
skillbox outdated
```

---

Agent：

```bash
skillbox agents
```

---

Link：

```bash
skillbox link claude
```

---

Unlink：

```bash
skillbox unlink cursor
```

---

Web：

```bash
skillbox web
```

---

Git：

```bash
skillbox sync
```

```bash
skillbox pull
```

```bash
skillbox push
```

```bash
skillbox status
```

---

Vendor：

```bash
skillbox vendor react-best-practices
```

---

Diff：

```bash
skillbox diff react-best-practices
```

---

Merge：

```bash
skillbox merge react-best-practices
```

---

# 34. 技术架构

推荐：

```text
                    Skillbox
                       │
                       ▼
                @skillbox/core
                       │
      ┌────────────────┼────────────────┐
      │                │                │
      ▼                ▼                ▼
 Skill Manager      Git Engine       Agent Manager
      │                │                │
      ▼                ▼                ▼
 Registry          Repository        Adapters
      │
      ▼
 Providers
```

UI：

```text
                    @skillbox/core
                           │
               ┌───────────┴───────────┐
               │                       │
               ▼                       ▼
        @skillbox/tui             @skillbox/web
               │                       │
           Terminal                localhost
```

---

# 35. Monorepo

推荐：

```text
skillbox/
│
├── packages/
│   │
│   ├── core/
│   │   ├── skills/
│   │   ├── agents/
│   │   ├── registry/
│   │   ├── git/
│   │   ├── security/
│   │   ├── filesystem/
│   │   └── config/
│   │
│   ├── cli/
│   │
│   ├── tui/
│   │
│   ├── web/
│   │
│   └── shared/
│
├── bin/
│   └── skillbox.mjs
│
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

建议使用：

```text
TypeScript
Node.js
pnpm workspace
```

---

# 36. Core API

UI 不应该直接操作文件。

所有能力通过 Core。

例如：

```ts
interface SkillService {
  list(): Promise<Skill[]>

  install(source: SkillSource): Promise<Skill>

  remove(skillId: string): Promise<void>

  update(skillId: string): Promise<void>

  create(input: CreateSkillInput): Promise<Skill>

  fork(skillId: string): Promise<Skill>

  vendor(skillId: string): Promise<Skill>

  diff(skillId: string): Promise<SkillDiff>

  merge(skillId: string): Promise<MergeResult>
}
```

Agent：

```ts
interface AgentAdapter {
  id: string

  detect(): Promise<boolean>

  getSkillDirectories(): Promise<string[]>

  listSkills(): Promise<InstalledSkill[]>

  link(skill: Skill): Promise<void>

  unlink(skill: Skill): Promise<void>
}
```

Registry：

```ts
interface RegistryProvider {
  search(query: string): Promise<SkillSearchResult[]>

  resolve(source: SkillSource): Promise<ResolvedSkill>

  download(skill: ResolvedSkill): Promise<SkillPackage>
}
```

---

# 37. Localhost Web 技术

CLI：

```text
skillbox web
```

启动：

```text
Local HTTP Server
+
Web Frontend
```

例如：

```text
Node Server
↓
http://127.0.0.1:43821
↓
Browser
```

前端可以考虑：

```text
React
Vite
TanStack Router
TanStack Query
shadcn/ui
```

服务端：

```text
Fastify
Hono
Express
```

其中比较推荐：

```text
Hono
```

或者：

```text
Fastify
```

核心原则：

> Web UI 只是 Core 的一个 Client。

---

# 38. TUI 技术

可以考虑：

```text
Ink
```

即 React-based Terminal UI。

优点：

- TypeScript
- React 开发体验
- Component 模型
- 和 Web 团队技术栈接近

也可以考虑：

```text
@clack/prompts
```

做较轻量交互。

第一版甚至不用做复杂 Fullscreen TUI。

可以先：

```text
Interactive CLI
```

后续再升级真正 TUI。

---

# 39. MVP 范围

第一版不要一次实现全部功能。

建议：

## V0.1

只实现四件事：

### Detect

自动发现：

```text
Claude
Codex
Cursor
Gemini
```

### Library

统一管理本地 Skills。

### Git

支持：

```text
init
connect
pull
push
sync
```

### UI

同时支持：

```text
npx skillbox
```

以及：

```text
npx skillbox web
```

---

# 40. V0.2

加入 Marketplace：

```text
skills.sh
GitHub
```

功能：

```text
Search
Install
Remove
Update
Trending
Official
Security
```

---

# 41. V0.3

加入：

```text
Managed
Forked
Local
Vendored
```

完整状态模型。

以及：

```text
Diff
Fork
Merge
Version
Rollback
```

---

# 42. V0.4

加入：

```text
Workspace
Preset
Project Scope
Global Scope
Profiles
Multi-device Conflict Resolution
```

---

# 43. Project Scope / Global Scope

未来支持：

```text
Global Skills
```

例如：

```text
~/.skillbox
```

同时也支持项目 Skills：

```text
project/
└── .skillbox/
```

例如：

```text
my-project/
├── src/
├── package.json
├── skillbox.yaml
└── skills/
```

Skillbox 自动合并：

```text
Global
+
Project
```

Skill。

---

# 44. Preset

未来可以增加：

```text
Frontend
Backend
Security
iOS
Python
React
DevOps
```

Preset。

例如：

```yaml
preset: frontend

skills:
  - react-best-practices
  - frontend-design
  - accessibility-review
  - playwright
```

用户：

```bash
skillbox use frontend
```

即可切换一组 Skill。

---

# 45. 多设备同步

设备 A：

```text
MacBook
```

设备 B：

```text
Windows PC
```

通过：

```text
GitHub Repository
```

同步。

注意：

> Git 仓库同步的是 Skill 状态，而不是 Agent 本地路径。

例如：

```text
Mac

~/.claude/skills

Windows

C:\Users\User\.claude\skills
```

路径信息必须由 Agent Adapter 本地解析。

绝对路径绝对不能进入：

```text
skillbox.lock
```

---

# 46. 跨平台

必须重点支持：

```text
macOS
Windows
Linux
```

特别注意：

```text
symlink
junction
path separator
permissions
executable bits
line endings
shell scripts
PowerShell
```

Skillbox Core 内部统一使用标准 Path API，不应自己拼接：

```text
/
\
```

---

# 47. 产品差异化

Skillbox 不应该和现有桌面 Skills Manager 直接拼：

```text
漂亮 GUI
```

真正差异化应该是：

## 1. Zero Install

```bash
npx skillbox
```

---

## 2. Git Native

GitHub 是用户自己的数据源。

---

## 3. Reproducible Environment

```text
skillbox.yaml
+
skillbox.lock
```

任何机器可恢复。

---

## 4. Multi-Agent

一套 Skill Library：

```text
Claude
Codex
Cursor
Gemini
OpenCode
```

共同使用。

---

## 5. Fork / Diff / Merge

第三方 Skill 修改后仍然能够：

```text
track upstream
```

---

## 6. Security

安装前、Push 前主动检查风险。

---

## 7. TUI + Web

服务器环境和桌面环境都能使用。

---

# 48. Git 同步的核心原则

最终同步策略可以总结为一句话：

> **默认 Reference + Lock；修改后 Fork；需要完全接管时 Vendor。**

对应：

```text
Third-party unchanged
      ↓
Managed
      ↓
只保存来源 + commit + hash

Third-party modified
      ↓
Forked
      ↓
保存完整 Skill + upstream metadata

User-created
      ↓
Local
      ↓
保存完整 Skill

User takes ownership
      ↓
Vendored
      ↓
保存完整 Skill，不再跟踪 upstream
```

---

# 49. 为什么这种方式比简单备份更好

普通 Skills Manager：

```text
~/.claude/skills
        ↓
     Copy
        ↓
GitHub
```

Skillbox 应该理解：

```text
哪些是 Dependency
哪些是 Source Code
哪些是 Fork
哪些是 Local
哪些有 Upstream
哪些发生 Modification
哪些可以 Update
哪些需要 Merge
```

因此 Skillbox 并不是：

> Skills Folder Backup Tool

而应该是：

> **Agent Skills Dependency & Source Management System**

---

# 50. 项目长期愿景

未来 Skillbox 可以进一步成为：

```text
Agent Environment Manager
```

不仅管理：

```text
Skills
```

未来还可以管理：

```text
MCP Servers
Rules
Prompts
Commands
Hooks
Agent Config
Environment Profiles
```

例如：

```text
skillbox.yaml

agents:
  claude:
    skills:
    mcp:
    hooks:

  codex:
    skills:
    mcp:

  cursor:
    rules:
    skills:
```

最终可以让用户：

```bash
git clone my-agent-env

npx skillbox install
```

直接恢复完整 AI Coding 环境。

这时 Skillbox 的定位会从：

```text
Skills Manager
```

自然演进为：

```text
Agent Environment Package Manager
```

---

# 51. 最终产品定义

推荐最终对外描述：

> **Skillbox is a local-first, Git-native package manager for Agent Skills. Manage, sync, customize and share skills across Claude Code, Codex, Cursor and other AI agents from one CLI.**

中文：

> **Skillbox 是一个 Local-first、Git-native 的 Agent Skills 包管理器，通过一个 CLI 统一管理 Claude Code、Codex、Cursor 等 Agent 的 Skills，并支持 GitHub 同步、可视化管理、版本控制、Fork、Diff 和 Merge。**

核心命令：

```bash
npx skillbox
```

核心价值：

```text
One library.
Every agent.
Every device.
Fully yours.
```

---

# 52. 推荐优先级

项目第一阶段优先完成：

```text
P0

Agent Detect
Local Skill Scan
Canonical Library
Agent Link
skillbox.yaml
skillbox.lock
Git Sync
Basic CLI
Basic Web UI
```

第二阶段：

```text
P1

Marketplace
Install
Update
Remove
Managed Skill
Security Scan
GitHub Repository Setup
```

第三阶段：

```text
P2

Forked Skill
Vendored Skill
Diff
3-way Merge
Rollback
Conflict Resolution
```

第四阶段：

```text
P3

Preset
Workspace
Profiles
MCP Management
Rules Management
Full Agent Environment
```

---

## 最核心的架构决策

如果项目现在开始实现，建议先固定以下几个原则，后续尽量不要改变：

```text
1. Git 是用户数据的 Source of Truth。

2. Skillbox Core 与 UI 解耦。

3. TUI 和 Web UI 共用同一套 Core。

4. Agent 差异通过 Adapter 屏蔽。

5. Marketplace 差异通过 Provider 屏蔽。

6. Third-party Skill 默认不完整进入 Git。

7. Managed Skill 使用 commit SHA + integrity lock。

8. 用户修改 Managed Skill 时转为 Forked。

9. Local / Forked / Vendored Skill 完整进入 Git。

10. Git Push 前必须进行 Secret Scan。

11. 不把绝对设备路径写入 Repository。

12. 优先保证 macOS / Windows / Linux 一致性。

13. Skillbox 本质上是 Package Manager，而不是 File Manager。

14. 第一阶段只专注 Skills，不急于扩展 MCP / Rules。

15. 所有设计优先保证：
    reproducibility、
    portability、
    ownership、
    interoperability。
```

这套方案可以作为 Skillbox 第一版的产品设计和技术架构基线。

后续如果准备正式开始开发，这份文档下一步最适合继续拆成 **`PRD.md`、`ARCHITECTURE.md`、`skillbox.yaml / lockfile specification` 和 MVP 开发任务列表** 四份文档。
