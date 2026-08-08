# Skillbox Product Requirements Document

> File: `PRD.md`
> Status: Draft
> Version: 0.2
> Last Updated: 2026-08-09

---

# 1. Overview

## 1.1 Product Name

**Skillbox**

暂定 CLI / NPM Package 名称：

```bash
npx skillbox
```

最终发布前需要确认 NPM Package、GitHub Organization / Repository 和相关域名是否可用。

---

## 1.2 Product Definition

Skillbox 是一个：

> **Local-first、Git-native、跨 Agent 的 Agent Skills Package Manager。**

用于统一管理 Claude Code、Codex、Cursor、Gemini CLI、OpenCode 等 AI Agent 使用的 Skills。

Skillbox 提供：

- CLI
- Interactive CLI / TUI
- Local Web UI
- GitHub Sync
- Skill Marketplace
- Skill Version Management
- Fork / Diff / Merge
- Multi-Agent Distribution
- Multi-device Sync
- Security Scan

核心启动命令：

```bash
npx skillbox
```

Web UI：

```bash
npx skillbox web
```

---

# 2. Product Vision

随着 AI Coding Agent 和通用 Agent 数量增加，Skills 正在逐渐成为一种新的开发者资产。

目前 Skills 生态存在明显碎片化：

```text
Claude Code
    ↓
~/.claude/skills

Codex
    ↓
~/.codex/skills

Cursor
    ↓
.cursor/skills

Gemini
    ↓
...

OpenCode
    ↓
...
```

用户面临的问题包括：

- 相同 Skill 需要重复安装
- 不同 Agent Skill 路径不同
- 不知道哪些 Agent 安装了哪些 Skills
- 多台设备无法方便同步
- 自定义 Skill 缺少版本管理
- 修改第三方 Skill 后难以升级
- 不知道第三方 Skill 是否存在安全风险
- Skills 越来越多后难以管理
- 换电脑需要重新配置整个 Agent 环境

Skillbox 希望解决：

> **Skills 应该像代码依赖一样，可以被安装、管理、锁定、修改、同步和恢复。**

长期愿景：

> 从 Agent Skills Package Manager 演进为 Agent Environment Manager。

未来可能统一管理：

```text
Skills
MCP Servers
Rules
Commands
Prompts
Hooks
Agent Config
```

但第一阶段只专注：

```text
Skills
```

---

# 3. Product Principles

Skillbox 的设计必须遵循以下原则。

## 3.1 Local First

所有核心数据必须首先存在于用户本地。

Skillbox 不依赖中心化 SaaS 才能工作。

即使：

```text
Skillbox Server
skills.sh
GitHub
```

不可访问，用户自己的 Skills 仍然应该可用。

---

## 3.2 User Ownership

Skill 文件属于用户。

Skillbox 不应建立：

```text
Vendor Lock-in
```

用户应该随时能够：

```bash
cd skills/
git status
vim SKILL.md
```

直接访问和编辑自己的文件。

---

## 3.3 Git Native

Git 是 Skillbox 最主要的：

```text
Version Control
Backup
Sync
History
Rollback
```

机制。

Skillbox 不重新发明一套私有版本控制系统。

---

## 3.4 Reproducible

同一个 Skillbox Repository 应该能够在不同设备上恢复尽可能一致的 Agent Skills 环境。

例如：

```bash
git clone git@github.com:user/my-agent-skills.git

cd my-agent-skills

npx skillbox install
```

即可恢复。

---

## 3.5 Agent Agnostic

Skillbox 不属于任何一个 Agent。

不应设计成：

```text
Claude Skills Manager
```

而应该是：

```text
Agent Skills Manager
```

不同 Agent 的差异由 Adapter 层解决。

---

## 3.6 Registry Agnostic

Skillbox 不绑定单一 Marketplace。

应该支持：

```text
skills.sh
GitHub
Local Repository
Private Repository
Future Registry
```

---

## 3.7 Provider Agnostic

Git 是 Skillbox 的同步协议，GitHub 是默认云端 Provider。

默认体验不得把底层同步模型锁死到 GitHub。系统应保留：

```text
GitHub Repository Provider   默认
Generic Git Provider         高级模式
Future Providers             GitLab / Gitea / Bitbucket / Self-hosted Git
```

GitHub 账号连接负责降低首次配置成本；用户仍然可以完全绕过它，直接连接 SSH 或 HTTPS Git remote。

---

## 3.8 CLI First

Skillbox 首先是一个开发者工具。

所有核心能力原则上都应该能够通过 CLI 使用。

Web UI 不应该成为必须依赖的能力。

---

# 4. Target Users

## 4.1 AI Coding Agent Heavy Users

同时使用：

```text
Claude Code
Codex
Cursor
Gemini CLI
OpenCode
```

等多个 Agent 的开发者。

痛点：

- Skills 重复安装
- Agent 配置分散
- 很难保持 Skills 一致

---

## 4.2 Skill Authors

经常：

```text
创建
修改
测试
发布
维护
```

Agent Skills 的用户。

需要：

- 编辑
- Git
- Diff
- Upstream Tracking
- Version History

---

## 4.3 Multi-device Developers

例如同时使用：

```text
MacBook
Windows PC
Linux Server
```

需要在设备之间同步 Agent Skills。

---

## 4.4 Team / Organization Users

未来可能将一套 Skills：

```text
Backend Team
Frontend Team
Security Team
iOS Team
```

共享给整个团队。

例如：

```text
company-agent-skills
```

Repository。

---

# 5. Primary User Stories

## 5.1 首次启动

用户执行：

```bash
npx skillbox
```

Skillbox 自动检测：

```text
Welcome to Skillbox

Detected Agents

✓ Claude Code
  12 skills

✓ Codex
  8 skills

✓ Cursor
  6 skills

○ Gemini CLI
  Not installed
```

然后询问：

```text
Import existing skills?

> Import All
  Select Skills
  Skip
```

---

## 5.2 安装 Skill

用户：

```bash
skillbox add vercel-labs/agent-skills@react-best-practices
```

Skillbox：

```text
Resolving skill...

react-best-practices

Source:
vercel-labs/agent-skills

Security:
Low Risk

Install for:

✓ Claude
✓ Codex
○ Cursor

Install?

> Yes
  Review Files
  Cancel
```

安装成功：

```text
Installed react-best-practices

Claude ✓
Codex  ✓
```

---

# 6. Skill Library

Skillbox 应维护统一的：

```text
Canonical Skill Library
```

所有 Agent 从 Canonical Library 获取 Skills。

概念：

```text
                 Skillbox Library
                        │
             ┌──────────┼──────────┐
             │          │          │
             ▼          ▼          ▼
          Claude      Codex      Cursor
```

优先使用：

```text
symlink
junction
```

如果环境不允许，则使用：

```text
copy
```

作为 fallback。

---

# 7. Agent Detection

Skillbox 应自动检测当前操作系统安装的 Agent。

初期 P0：

```text
Claude Code
Codex
Cursor
```

P1：

```text
Gemini CLI
OpenCode
```

后续：

```text
Windsurf
GitHub Copilot
其他支持 Agent Skills 的工具
```

每个 Agent 显示：

```text
Name
Detected / Not Detected
Version
Skill Directory
Installed Skill Count
```

---

# 8. Skill States

Skillbox 定义四种核心 Skill 状态：

```text
Managed
Forked
Local
Vendored
```

---

# 9. Managed Skill

定义：

> 来自第三方 Upstream，并且用户未修改的 Skill。

例如：

```text
vercel-labs/agent-skills
└── react-best-practices
```

Managed Skill：

```text
完整文件进入用户 Git：No
跟踪 Upstream：Yes
自动更新：Yes
支持 Diff：Yes
```

Git 中只记录：

```text
source
repository
path
revision
integrity
```

---

# 10. Forked Skill

当用户修改 Managed Skill 时：

```text
Managed
   ↓
Edit
   ↓
Forked
```

Forked Skill：

```text
完整文件进入 Git：Yes
跟踪 Upstream：Yes
自动覆盖更新：No
支持 Diff：Yes
支持 Merge：Yes
```

用户修改第三方 Skill 时，Skillbox 应提示：

```text
This skill is managed by an upstream source.

Editing it will create a local fork.

Upstream:
vercel-labs/agent-skills

[Create Fork & Edit]
[Cancel]
```

---

# 11. Local Skill

定义：

> 用户自己创建的 Skill。

例如：

```bash
skillbox create my-code-review
```

Local Skill：

```text
完整文件进入 Git：Yes
跟踪 Upstream：No
自动更新：No
```

---

# 12. Vendored Skill

定义：

> 从第三方 Skill 转为完全由用户维护。

命令：

```bash
skillbox vendor react-best-practices
```

Vendored：

```text
完整文件进入 Git：Yes
跟踪 Upstream：No
自动更新：No
```

与 Forked 最大区别：

```text
Forked
→ 仍然知道 Upstream

Vendored
→ 不再跟踪 Upstream
```

---

# 13. State Summary

| Mode | Full Files in Git | Track Upstream | Auto Update | Merge |
|---|---:|---:|---:|---:|
| Managed | No | Yes | Yes | N/A |
| Forked | Yes | Yes | No | Yes |
| Local | Yes | No | No | N/A |
| Vendored | Yes | No | No | N/A |

---

# 14. Git Sync

GitHub Sync 是核心功能。

Skillbox Repository 默认结构：

```text
my-agent-skills/
│
├── skillbox.yaml
├── skillbox.lock
├── .skillboxignore
├── .gitignore
│
└── skills/
    ├── my-code-review/
    ├── my-backend-rules/
    └── forked-third-party-skill/
```

其中：

```text
skills/
```

默认只保存：

```text
Local
Forked
Vendored
```

普通 Managed Skill 不完整保存。

---

# 15. Manifest

Skillbox 使用：

```text
skillbox.yaml
```

描述用户期望状态。

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

  my-code-review:
    source:
      type: local
      path: ./skills/my-code-review

    agents:
      - claude
      - codex
```

---

# 16. Lockfile

Skillbox 使用：

```text
skillbox.lock
```

记录精确版本。

例如：

```yaml
lockfileVersion: 1

skills:
  react-best-practices:
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices

    revision: 07a81df7a84e

    integrity: sha256-a72c...

    mode: managed
```

核心原则：

```text
skillbox.yaml
=
Desired State

skillbox.lock
=
Resolved State
```

---

# 17. GitHub Setup

0.2 的默认同步入口是：

```text
Connect GitHub
      ↓
Authorize with GitHub Device Flow
      ↓
Create or select a repository
      ↓
Initialize local Git
      ↓
Initial commit and push
```

首次运行展示：

```text
Backup & Sync

Keep your skills synced across devices.

[ Connect GitHub ]
[ Skip for now ]
```

连接成功后，用户选择：

```text
Create a new repository
Use an existing repository
Advanced Git remote
Do not enable sync
```

新建仓库默认值：

```text
Name: skillbox-skills
Visibility: Private
Branch: main
```

创建操作必须在一次可恢复流程中完成：创建 GitHub Repository、初始化 Git、写入普通 HTTPS remote、生成初始提交并 Push。失败时必须明确显示完成到哪一步，并允许重试，不得重复创建仓库或丢失本地文件。

### 17.1 Authentication Model

默认使用支持 Device Flow 的 Skillbox GitHub App。公开分发的 NPM CLI 只包含 Client ID，不包含 Client Secret。

权限遵循最小授权原则：

```text
Metadata                 Read
Contents                 Read / Write
Administration           Write, only when creating a repository
```

GitHub App user access token 和 refresh token 只能保存在操作系统 Credential Store：

```text
macOS      Keychain
Windows    Credential Manager
Linux      Secret Service
```

`~/.skillbox/config.json` 只保存非敏感连接元数据，例如 login、provider 和 repository，不保存任何 token。

### 17.2 Git Transport Authentication

GitHub Connect 获得的用户凭证同时可用于 GitHub REST API 和 Git HTTPS transport。执行 fetch、pull、push 时，Skillbox 通过临时 credential helper 或等价的进程级机制向系统 Git 提供凭证。

禁止把 token：

```text
写入 remote URL
写入 .git/config
写入 Manifest / Lockfile
写入日志、错误或 debug bundle
```

Remote 只保存普通 URL：

```text
https://github.com/user/skillbox-skills.git
```

### 17.3 Advanced Git Mode

高级用户仍然可以运行：

```bash
skillbox git init
skillbox git connect git@github.com:user/my-agent-skills.git
```

该模式继续使用用户现有的 SSH Agent、Git Credential Manager、`gh` 或系统 Git 凭证，不要求连接 Skillbox GitHub App。

认证优先级为：

```text
1. Skillbox GitHub Connect
2. Existing gh / Git credentials
3. Manual HTTPS / SSH remote
```

### 17.4 Gist Positioning

Gist 不属于 0.2 默认同步方案。Secret Gist 不等同于 Private Repository，而且不适合持续增长的完整 Skill workspace。

如果未来提供 Gist Provider，它只能作为显式选择的轻量分享能力，不能承载 Safe by Default 的私有备份承诺。

---

# 18. Sync

命令：

```bash
skillbox sync
```

用户视角逻辑：

```text
Scan
↓
Detect Changes
↓
Secret Scan
↓
Pull
↓
Resolve
↓
Commit
↓
Push
```

同时提供高级命令：

```bash
skillbox status

skillbox pull

skillbox push
```

---

# 19. Multi-device Restore

用户新电脑执行：

```bash
git clone git@github.com:user/my-agent-skills.git

cd my-agent-skills

npx skillbox install
```

Skillbox：

```text
Detected:

✓ Claude Code
✓ Codex

Restoring managed skills...

✓ react-best-practices
✓ frontend-design

Restoring local skills...

✓ my-code-review
✓ backend-rules

Linking agents...

✓ Claude
✓ Codex

Environment restored.
```

---

# 20. Marketplace

Skillbox 不建设自己的中心化 Registry。

第一阶段支持：

```text
skills.sh
GitHub
```

通过：

```bash
skillbox search react
```

搜索。

Web UI：

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

# 21. Skill Install Page

应显示：

```text
Skill Name

Description

Source

Repository

Revision

Files

Compatibility

Security

Installed Agents
```

例如：

```text
React Best Practices

Source
vercel-labs/agent-skills

Files

SKILL.md
references/
scripts/

Security

LOW RISK

Compatible Agents

✓ Claude
✓ Codex
✓ Cursor

[Install]
```

---

# 22. Update Management

查看更新：

```bash
skillbox outdated
```

例如：

```text
Skill                   Installed     Latest

react-best-practices    07a81df       a81bb29
frontend-design         12dc932       84dde11
```

更新：

```bash
skillbox update
```

或者：

```bash
skillbox update react-best-practices
```

---

# 23. Managed Skill Update

Managed Skill：

```text
Installed
07a81df

Latest
a91c823

[View Diff]
[Update]
```

可以直接升级。

升级后：

```text
skillbox.lock
```

更新 Revision 和 Integrity。

---

# 24. Forked Skill Update

Forked Skill 不允许直接覆盖。

显示：

```text
Upstream update available

Base:
07a81df

Local modifications:
8

Upstream modifications:
12

[View Diff]
[Merge]
[Ignore]
```

---

# 25. Diff

Skillbox 应支持：

```bash
skillbox diff react-best-practices
```

Managed：

```text
Current
vs
Latest Upstream
```

Forked：

```text
Base
Local
Upstream
```

Web UI 应支持 Side-by-side Diff。

---

# 26. Merge

Forked Skill 更新采用：

```text
3-way Merge
```

模型：

```text
              Base
             /    \
            /      \
         Local    Upstream
            \      /
             \    /
              Merge
```

冲突时：

```text
SKILL.md

[Local version]

...

[Conflict separator]

...

[Upstream version]
```

Web UI 后续可以提供可视化冲突解决工具。

---

# 27. Security Scan

安全是 Skillbox 的 P1 功能。

安装第三方 Skill 前扫描：

```text
Shell Execution

Network Access

Filesystem Writes

Credential Access

Environment Variables

SSH Access

sudo

curl | bash

rm -rf

PowerShell

External Executables
```

展示：

```text
Security Analysis

✓ No credential access
✓ No SSH access

! Network request detected
! Shell script detected

Risk

MEDIUM
```

---

# 28. Secret Scan

Git Push 前必须扫描 Secrets。

至少检测：

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

高可信 Secret：

```text
Push blocked
```

用户可以：

```text
Review

Ignore Once

Add to Ignore
```

---

# 29. .skillboxignore

支持：

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

references/internal/
```

用途：

> 控制 Skillbox Sync、Scan 和 Backup 行为。

注意：

```text
.skillboxignore
```

与：

```text
.gitignore
```

职责不同。

---

# 30. CLI

核心命令：

```bash
skillbox
```

进入 Interactive CLI / TUI。

---

## Skill Management

```bash
skillbox list
```

```bash
skillbox search <query>
```

```bash
skillbox add <source>
```

```bash
skillbox remove <skill>
```

```bash
skillbox create <name>
```

```bash
skillbox edit <skill>
```

```bash
skillbox update [skill]
```

```bash
skillbox outdated
```

---

## Source Management

```bash
skillbox fork <skill>
```

```bash
skillbox vendor <skill>
```

```bash
skillbox diff <skill>
```

```bash
skillbox merge <skill>
```

---

## Agent Management

```bash
skillbox agents
```

```bash
skillbox link <agent>
```

```bash
skillbox unlink <agent>
```

---

## Git

```bash
skillbox status
```

```bash
skillbox sync
```

```bash
skillbox pull
```

```bash
skillbox push
```

---

## Web

```bash
skillbox web
```

支持：

```bash
skillbox web --port 3000
```

```bash
skillbox web --no-open
```

---

# 31. Interactive CLI / TUI

运行：

```bash
npx skillbox
```

进入：

```text
┌─────────────────────────────────┐
│ Skillbox                        │
│                                 │
│ › My Skills                     │
│   Explore                       │
│   Updates                       │
│   Agents                        │
│   Git Sync                      │
│   Open Web UI                   │
│   Settings                      │
│                                 │
└─────────────────────────────────┘
```

TUI 主要用于：

```text
快速操作

SSH

服务器

无浏览器环境

高级开发者
```

---

# 32. Web UI

运行：

```bash
npx skillbox web
```

启动：

```text
http://127.0.0.1:43821
```

CLI 输出：

```text
Skillbox

Local:
http://127.0.0.1:43821

✓ Claude detected
✓ Codex detected

24 skills loaded

Opening browser...
```

---

# 33. Web Navigation

第一版：

```text
Library

Explore

Updates

Agents

Git

Settings
```

---

# 34. Library Page

展示：

```text
My Skills

24 Skills
```

Skill Card：

```text
React Best Practices

Managed

vercel-labs/agent-skills

Agents

Claude ✓
Codex ✓
Cursor ○

Upstream

Up to date

Security

Low Risk

[Open]
[Agents]
[Update]
[Remove]
```

---

# 35. Forked Skill Card

```text
React Best Practices

Forked

Local modifications
8

Upstream modifications
12

[Edit]

[Diff]

[Merge]
```

---

# 36. Agents Page

```text
Agents

Claude Code

Detected

12 Skills

────────────────────

Codex

Detected

9 Skills

────────────────────

Cursor

Detected

6 Skills
```

Agent Detail：

```text
Claude Code

Skills

✓ react-best-practices

✓ frontend-design

✓ my-code-review

○ security-review
```

用户可以启用/禁用具体 Skill。

---

# 37. GitHub & Git Page

展示：

```text
GitHub

Connected as user

Authentication

Skillbox GitHub App

Repository

github.com/user/my-agent-skills

Branch

main

Status

3 modified files

Last Sync

2 minutes ago
```

Changes：

```text
M skills/my-code-review/SKILL.md

M skillbox.lock

A skills/new-skill/
```

操作：

```text
Pull

Commit

Push

Sync

Open Repository

Disconnect GitHub
```

Disconnect 只撤销或删除本机保存的 GitHub 凭证和连接元数据，不删除本地 Repository，不删除 GitHub Repository，也不自动移除 Git remote。界面必须在操作前说明这一边界。

---

# 38. Settings

第一版至少包括：

```text
Skillbox Home

Default Git Repository

GitHub Account

GitHub Repository

Default Branch

Auto Open Browser

Web Port

Preferred Install Strategy

Symlink / Copy

Security Scan

Secret Scan

Agent Paths
```

---

# 39. MVP

## V0.1 — Local Management

目标：

> 能够真正取代手动管理多个 Agent 的 Skills 文件夹。

P0：

```text
Agent Detection

Local Skills Scan

Canonical Library

Import Existing Skills

Agent Link / Unlink

skillbox.yaml

skillbox.lock

Basic CLI

Interactive CLI

Basic Web UI
```

---

# 40. V0.2 — Git Sync

加入：

```text
Git Init

Git Connect

GitHub App Device Flow

OS Credential Store

Create Private Repository

Select Existing Repository

GitHub HTTPS Authentication

Token Refresh

Disconnect Account

Status

Pull

Push

Sync

Multi-device Restore

Secret Scan
```

---

# 41. V0.3 — Marketplace

加入：

```text
skills.sh

GitHub Source

Search

Install

Remove

Update

Outdated

Security Information
```

---

# 42. V0.4 — Skill Lifecycle

正式加入：

```text
Managed

Forked

Local

Vendored

Diff

Fork

Vendor

3-way Merge

Rollback
```

---

# 43. Future Scope

暂时不进入 MVP：

```text
MCP Server Management

Rules Management

Prompt Management

Hooks Management

Remote SaaS Dashboard

Team Billing

Cloud Database

Enterprise RBAC
```

---

# 44. Project Scope

未来支持项目级 Skill。

例如：

```text
my-project/
│
├── src/
├── package.json
│
├── skillbox.yaml
│
└── skills/
```

最终有效 Skill：

```text
Global Skills
+
Project Skills
```

---

# 45. Presets

未来支持：

```text
Frontend

Backend

Security

iOS

Python

React

DevOps
```

例如：

```yaml
preset: frontend

skills:
  - react-best-practices
  - frontend-design
  - accessibility
  - playwright
```

命令：

```bash
skillbox use frontend
```

---

# 46. Non-goals

Skillbox 第一阶段明确不做：

## 46.1 不建立新的 Skills Registry

优先利用：

```text
skills.sh

GitHub
```

---

## 46.2 不做 Skills SaaS 云盘

GitHub 已经可以承担：

```text
Sync

Backup

History
```

---

## 46.3 不做新的 Skill 标准

Skillbox 尽量兼容现有 Agent Skills 规范。

---

## 46.4 不强制桌面客户端

不会要求用户安装：

```text
Electron

Tauri
```

才能使用。

---

## 46.5 不在 MVP 管理所有 Agent 配置

第一阶段：

```text
Skills only
```

---

# 47. Cross-platform Requirements

必须支持：

```text
macOS

Windows

Linux
```

需要特别处理：

```text
symlink

junction

permissions

path separator

executable bits

line endings

shell scripts

PowerShell
```

不得将当前设备的绝对路径同步到 Repository。

例如禁止：

```yaml
path: C:\Users\Zheng\.claude\skills
```

或者：

```yaml
path: /Users/zheng/.claude/skills
```

出现在共享 Lockfile 中。

---

# 48. UX Principles

## 48.1 Safe by Default

可能破坏数据的行为必须明确提示。

例如：

```text
Remove Skill

Discard Local Changes

Overwrite

Merge

Push Secret
```

---

## 48.2 Explain State

用户应该始终知道 Skill 是：

```text
Managed

Forked

Local

Vendored
```

而不是只有内部系统知道。

---

## 48.3 Avoid Git Complexity

普通用户不需要理解：

```text
rebase

cherry-pick

detached HEAD
```

Skillbox 应把常见 Git 操作包装成：

```text
Sync

Update

Restore

Merge
```

---

## 48.4 Advanced Users Can Escape

高级用户仍然可以直接：

```bash
git
```

操作 Repository。

Skillbox 不应阻止正常 Git 工作流。

---

# 49. Data Ownership

Skillbox 默认：

```text
No Skill Content Upload
```

除非用户主动：

```text
git push
```

到自己的 Repository。

Skillbox 不应默认上传用户 Skill 内容到 Skillbox 服务。

---

# 50. Privacy

Local Web UI 默认必须绑定：

```text
127.0.0.1
```

而不是：

```text
0.0.0.0
```

除非用户主动指定。

例如：

```bash
skillbox web --host 0.0.0.0
```

应明确显示安全警告。

---

# 51. Success Metrics

开源项目早期重点观察：

```text
GitHub Stars

NPM Downloads

Unique Installations

Weekly Active CLI Users

Skills Managed

Git Repositories Connected
```

产品行为指标：

```text
Average Skills per User

Average Agents per User

Multi-device Usage

Managed → Forked Conversion

Marketplace Install Count

Sync Frequency
```

---

# 52. MVP Success Criteria

V0.1 达成以下条件即可认为 MVP 有效。

一个同时安装：

```text
Claude Code
Codex
```

的用户可以：

1. 执行：

```bash
npx skillbox
```

2. 自动发现两个 Agent。

3. 扫描现有 Skills。

4. 将 Skills 导入 Canonical Library。

5. 查看每个 Skill 当前在哪些 Agent 中启用。

6. 从一个 UI 中完成：

```text
Enable

Disable

Create

Edit

Remove
```

7. 运行：

```bash
npx skillbox web
```

在浏览器完成相同的核心管理操作。

---

# 53. Git Sync Success Criteria

Git Sync 阶段达成：

未配置 Git 的普通用户可以从首次运行开始完成：

```text
Connect GitHub
↓
Authorize
↓
Create a private repository
↓
Initial sync
```

全过程不需要手动创建 Repository、复制 remote URL 或在 `.git/config` 中保存 token。

同时必须满足：

```text
Access token 和 refresh token 只存在于 OS Credential Store
Token 过期可刷新或明确要求重新授权
Disconnect 不删除本地或远程数据
高级 SSH / Generic Git 流程仍然可用
```

用户 A 在 Mac 上：

```bash
skillbox sync
```

然后在 Windows：

```bash
git clone ...

npx skillbox install
```

能够：

```text
恢复 Local Skills

恢复 Forked Skills

恢复 Vendored Skills

重新下载 Managed Skills

恢复 Agent Assignment
```

并且：

```text
不依赖原机器绝对路径

不会意外提交 Secrets
```

---

# 54. Core Product Differentiation

Skillbox 不应该强调：

> 我们也有一个 Skills GUI。

真正差异化应该是：

### Zero Install

```bash
npx skillbox
```

### Git Native

用户自己的 Git Repository 是数据资产。

### Multi-Agent

```text
One Library
Every Agent
```

### Multi-device

```text
One Repository
Every Device
```

### Reproducible

```text
skillbox.yaml
+
skillbox.lock
```

### Fork-aware

第三方 Skill 可以：

```text
Modify
+
Track Upstream
```

### Safe

安装和 Git Push 都具有安全保护。

---

# 55. Product Positioning

英文：

> **Skillbox is a local-first, Git-native package manager for Agent Skills. Manage, sync, customize and share skills across Claude Code, Codex, Cursor and other AI agents from one CLI.**

中文：

> **Skillbox 是一个 Local-first、Git-native 的 Agent Skills 包管理器，通过一个 CLI 统一管理 Claude Code、Codex、Cursor 等 Agent 的 Skills，并提供跨设备同步、版本控制、Fork、Diff、Merge 和可视化管理能力。**

---

# 56. Tagline

主要候选：

```text
One command to manage every skill, for every agent.
```

或者：

```text
One library.
Every agent.
Every device.
```

更偏品牌化：

```text
Your skills. Every agent. Fully yours.
```

---

# 57. Long-term Vision

长期架构：

```text
                     Skillbox
                        │
        ┌───────────────┼───────────────┐
        │               │               │
      Skills           MCP            Rules
        │               │               │
        └───────────────┼───────────────┘
                        │
                  Agent Profile
                        │
         ┌──────────────┼──────────────┐
         │              │              │
      Claude          Codex          Cursor
```

未来用户只需要：

```bash
git clone my-agent-env

npx skillbox install
```

即可恢复：

```text
Skills

MCP Servers

Rules

Hooks

Commands

Agent Configuration
```

最终产品定位：

> **Agent Environment Package Manager**

但在 Skillbox 0.x 阶段：

> **Stay focused on Skills.**
