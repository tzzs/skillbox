# 0.1.0 End-to-End Acceptance Test（E2E 验收手册）

> **来源：** MVP_TASKS §98 — 0.1.0 End-to-End Acceptance Test
> **状态：** 手工验收手册 + 自动化覆盖（`packages/testing`，CI `pnpm test:e2e` 在 build 后执行）
> **版本：** 0.2
> **Last Updated：** 2026-08-15

## 0. 自动化覆盖（已落地并全绿）

以下旅程由 `packages/testing` 的 Hermetic CLI E2E 自动执行（真实 CLI 子进程 + 临时
`SKILLBOX_HOME`/仓库；git 旅程需要系统 git，connect 旅程用本地假 GitHub 服务器，无需网络）：

| 旅程 | 文件 | 状态 |
|------|------|------|
| version / create → list → remove / install / 未知命令 | `e2e.test.ts` | ✅ 5 例通过 |
| create → commit → push → fresh-clone → pull → status（bare remote fixture） | `e2e-git.test.ts` | ✅ 2 例通过 |
| connect：Device Flow → 建私仓 → git init → 绑定 origin（本地假 GitHub API） | `e2e-connect.test.ts` | ✅ 4 例通过（slow_down / denied / expired / success） |

运行方式：`pnpm build && pnpm test:e2e`（CI build job 已接入）。测试基线（本机，git 2.47.3）：
core 776/776、CLI 295/295、e2e 8/8、typecheck/lint/build 全绿。

> 自动化已覆盖：授权 slow_down 重试、denied/expired 失败和私仓认证失败。三平台（Windows/macOS/Linux）真实 Agent 目录
> 与 Credential Store 行为仍需发布前手工验收。

---

## 1. 前置条件

验收场景：在一个**全新的临时 HOME + 全新空目录**里，模拟一个从未安装过 Skillbox 的用户，从零到可用完整跑通 10 步。

| 前置 | 要求 |
|------|------|
| 本机 Agent | 已安装 **Claude Code** 与 **Codex**，且各自 SKILLS 目录下已存在既有 Skill（用于演示外来 Skill） |
| 构建产物 | 已 `pnpm build`（否则 Web 页 404） |
| 全新环境 | `SKILLBOX_HOME` 指向空目录；工作目录指向空仓库目录 |

> 若本机暂时没有 Claude/Codex 对应的既有 Skill，可先用 `skillbox create` 造一个 local skill 替代，再把第 4/5 步的"外部 Skill"改为该 local skill。本文以「已存在外部 Skill」为标准路径。

### 环境准备（以 bash 为例）

```bash
export SB_HOME=$(mktemp -d)          # 全新 Skillbox home
export SB_REPO=$(mktemp -d)          # 全新受管仓库
cd "$SB_REPO"                        # 空目录
unset SKILLBOX_HOME
```

> 后续所有命令都需带上 `SKILLBOX_HOME="$SB_HOME"` 环境变量，并把 `skillbox` 替换为仓库内可执行文件：
> `node /path/to/skillbox/packages/cli/bin/skillbox.mjs`

---

## 2. 验收步骤（10 步）

### Step 1 · Detect Agents（检测两个 Agent）

**操作** | 在临时空仓库运行：

```bash
SKILLBOX_HOME="$SB_HOME" \
  node /path/to/skillbox/packages/cli/bin/skillbox.mjs agents
```

**预期**：输出一张 `AGENT / STATUS / SKILLS` 表格：

```text
AGENT   STATUS    SKILLS
------  --------  ------
Claude  detected  2
Codex   detected  1
```

其中 `detected = yes`：两个 Agent 均被识别；`SKILLS` 列为既有 Skill 数量（大于 0）。

> 也可用机器可读形式：加 `--json`，字段 `detected / skillCount / skillDirectories` 应存在且内容合理。

---

### Step 2 · Scan Existing Skills（扫描既有 Skills）

**操作** | 启动交互菜单，观察欢迎区 "Step 2 · Scan existing skills"：

```bash
SKILLBOX_HOME="$SB_HOME" node /path/to/skillbox/packages/cli/bin/skillbox.mjs
```

**预期**

- 屏幕打印 Welcome 区块（Agent 状态摘要 + 当前 Skill 数）。
- 显示：`Found N unmanaged external skill(s).`（N > 0，即既有外部 Skills 被扫描到）。
- 询问是否导入：选择 **Import**。

---

### Step 3 · Import Existing Skills（导入）

**操作** | 接上一步，在交互菜单选择这些外部 Skill（或全选），确认导入。

**预期**

- 每个选中的外部 Skill 完成导入，提示 `Imported "<name>".`
- 导入后，`skillbox list` 应能列出这些 Skill。

**验证命令：**

```bash
SKILLBOX_HOME="$SB_HOME" node /path/to/skillbox/packages/cli/bin/skillbox.mjs list
```

预期：表格含刚导入的 Skill 记录，`MODE = managed`（来源为外部 Agent 的 Skill 被收编为 managed）。

---

### 4 · Generate Manifest（生成 skillbox.yaml）

**操作** | 查看仓库根目录。

**预期**：出现 `skillbox.yaml`，内容是受管 Skills 的 manifest。

```bash
cat skillbox.yaml
```

预期形如：

```yaml
version: 1
skills:
  existing-skill-a:
    source:
      type: local
      path: skills/existing-skill-a
    mode: managed
    agents: []
```

> 关键点：manifest 字段完整、YAML 确定性序列化、`version: 1`。

---

### 5 · Generate Lockfile（生成 skillbox.lock）

**操作** | 查看仓库根目录的 `skillbox.lock`。

```bash
cat skillbox.lock
```

预期形如：

```yaml
lockfileVersion: 1
skills:
  existing-skill-a:
    mode: managed
    source:
      type: local
      path: skills/existing-skill-a
    integrity: sha256:...
```

**验证点**：每个受管 Skill 都有 integrity 字段（sha256 规范哈希），这是后续 modified 识别的依据。

---

### 6 · Create Canonical Library（建立 ~/.skillbox/library）

**操作** | 查看 canonical library 目录。

```bash
ls "$SB_HOME/library"
```

预期：

```text
managed/  local/
```

受管 Skill 在 `library/managed/<skill>/` 下有实体（symlink/junction 或 copy 格式依 link strategy）；local 或 source skill 在 `library/local/`。

---

### 7 · Enable the same Skill for two Agents（把一个 Skill 同时启用给两个 Agent）

**操作** | 在交互菜单选择某个 Skill → "Enable/Disable"，分别勾选 Claude、Codex；或直接用 CLI：

```bash
SKILLBOX_HOME="$SB_HOME" node /path/to/skillbox/packages/cli/bin/skillbox.mjs enable existing-skill-a --agent claude
SKILLBOX_HOME="$SB_HOME" node /path/to/skillbox/packages/cli/bin/skillbox.mjs enable existing-skill-a --agent codex
```

**预期**：

```text
Enabled "existing-skill-a" for agent "claude"
Enabled "existing-skill-a" for agent "codex"
```

**验证 manifest 变更**：`skillbox.yaml` 中该 skill 的 `agents` 字段现在为：

```yaml
    agents:
      - claude
      - codex
```

**验证 agent 链接**：对应 Agent 的 skills 目录（如 `~/.claude/skills`）出现了指向该 Skill 的链接（symlink / junction / copy，取决于 link strategy）。

---

### 8 · Edit the local skill（编辑 Skill 内容）

**操作** | 在仓库内找到该 Skill 的本地源文件（如 `skills/existing-skill-a/SKILL.md`），用任意编辑器修改内容（追加一行即可）。

```bash
echo "# changed" >> skills/existing-skill-a/SKILL.md
```

**预期**：文件内容变化，但 manifest/lockfile 未改动。

---

### 9. Integrity 识别为 modified

**操作** | 再次查看状态：

```bash
SKILLBOX_HOME="$SB_HOME" node /path/to/skillbox/packages/cli/bin/skillbox.mjs status
```

预期：

- Skills 表中该 Skill 状态为 **`modified`**（integrity 检测到与 lockfile 哈希不一致）。
- "Modified skills" 小节列出该技能名称。

也可用机器输出验证：

```bash
SKILLBOX_HOME="$SB_HOME" node .../skillbox.mjs status --json
```

预期：`skills[].status == "modified"`，且 `modified` 数组包含 `existing-skill-a`。

**说明**：这是 Integrity（M4）本地修改检测的核心验收点。

---

### 10 · Web UI 查看与修改 Assignment

**操作** | 在仓库根启动 Web UI：

```bash
SKILLBOX_HOME="$SB_HOME" node /path/to/skillbox/packages/cli/bin/skillbox.mjs web --no-open
# 打印 URL，如 Skillbox web UI: http://127.0.0.1:43821
```

打开浏览器访问该地址，或用 `curl` 走 API：

```bash
curl http://127.0.0.1:43821/api/status
```

预期：

```json
{ "skills": [ { "name": "existing-skill-a", "status": "modified", "mode": "..." } ], ... }
```

#### 10a · 在 Web UI 修改 Assignment

WebUI 支持把 Skill 再分配给 Agent。典型过程：

1. 进入 Skill 详情页（`/skills/<name>`），看到 "Agents" 区块，当前 Claude + Codex 已启。
2. 点击 disable `claude`，保存。

**校验命令**（对应 `POST /api/skills/:id/disable`）：

```bash
curl -X POST http://127.0.0.1:43821/api/skills/existing-skill-a/disable \
  -H 'content-type: application/json' -d '{"agent":"claude"}'
```

预期：返回 `{"assignment":{"name":"existing-skill-a","agent":"claude","enabled":false}}`（或等价结构）。

**验证落盘**：`skillbox.yaml` 中 `agents` 列表不再含 `claude`：

```bash
grep -A3 'agents' skillbox.yaml
```

#### 10b. 反向操作（重新启用）

```bash
curl -X POST http://127.0.0.1:43821/api/skills/existing-skill-a/enable \
  -H 'content-type: application/json' -d '{"agent":"claude"}'
```

预期 `claude` 重新出现在 `agents` 中。

#### 10c. 结束

按 **Ctrl+C** 停止 Web 服务，退出交互菜单。

---

## 3. 验收通过标准（Checklist)

运行到此处，全部 10 步可见成功即视为通过：

- [x] 1 Detect：`agents` 输出两个 Agent 且都 `detected` — 实测表格 `Claude detected 2` / `Codex detected 2`；`agents --json` 中两者 `detected=true`、`confidence=high`、`skillCount=2`、`skillDirectories` 指向沙箱内的 `$HOME/.claude/skills`、`$HOME/.codex/skills`（Agent 目录为**伪造**，见下方"仍需本机确认"）
- [x] 2 Scan：找到既有外部 Skills — 交互欢迎区打印 `Step 2 · Scan existing skills` + `Found 3 unmanaged external skills.`
- [x] 3 Import：交互内成功导入外插 Skill — 多选全选后逐条输出 `Imported "external-alpha".` / `Imported "external-beta".` / `Imported "shared-skill".` + `Imported 3 skills.`；`skillbox list` 列出 3 条，但 `MODE = local`（不是本节旧预期的 `managed`，见差异 a）
- [x] 4 Manifest：根目录生成 `skillbox.yaml` — 首行 `version: 1`，3 个 skill 均含 `source.type: local` + `path: skills/<alias>` + `mode` + `agents`
- [x] 5 Lockfile：根目录生成 `skillbox.lock`（含 integrity）— `lockfileVersion: 1`，逐 skill `integrity: sha256:...`（如 external-alpha `sha256:c7e96fbc4c1ce4…`）
- [x] 6 Library：`~/.skillbox/library` 出现受管 Skill 实体 — `library/local/<skill>/SKILL.md` 为真实文件，且 `$HOME/.claude/skills/<skill>`、`$HOME/.codex/skills/<skill>` 为指回 library 的 symlink；`library/managed/` 只在远程来源时出现（另在 `repo4` 用 `type: git` 源验证得到 `library/managed/demo-git-skill/SKILL.md`，`list` 显示 `MODE = managed`）
- [x] 7 Enable：同一 Skill 同时启用给两个 Agent（manifest agents 字段更新）— `Enabled "external-alpha" for agent "claude"` / `Enabled "external-alpha" for agent "codex"`，`skillbox.yaml` 的 `agents` 变为 `[claude, codex]`，两个 Agent 目录各出现一条 symlink
- [x] 8 Edit：本地文件被修改 — 往 `skills/external-alpha/SKILL.md` 追加一行后，`skillbox.yaml` / `skillbox.lock` 完全没动（锁里仍是导入时的 `sha256:c7e96fbc…`，而实际内容已变成 `sha256:848ffd5b…`，差异正是第 9 步的依据）
- [x] 9 modified：`skillbox status` 显示 `modified` — Skills 表 `external-alpha local modified` + 独立小节 `Modified skills: external-alpha`；`status --json` 为 `skills[].status == "modified"`、`modified == ["external-alpha"]`
- [x] 10 Web：Web UI 正常打开，Assignment 可查看可修改（API + manifest 落盘一致）— `web --port 44781 --no-open` 打印 `Skillbox web UI: http://127.0.0.1:44781`，`GET /` 返回 `200 text/html`；`GET /api/skills/external-alpha` 报 `agents: [claude, codex]` + `status: modified`；`POST .../disable {"agent":"claude"}` 返回 200（`manifestChanged: true`、`staleLinks` 移除 claude），磁盘 `skillbox.yaml` 的 `agents` 随即只剩 `codex`；`POST .../enable {"agent":"claude"}` 后 API 与磁盘重新一致为 `[codex, claude]` 且 claude 侧 symlink 复原。**浏览器渲染未验证**（本次只有 curl 层，见差异 e）

### 3.1 本次执行环境

一行说明：本轮 10 步全部在 macOS 一次性沙箱内执行 —— `Darwin 27.0.0`（arm64）、`git version 2.54.0 (Apple Git-157)`、`node v24.13.0`，分支 `fix/sync-managed-pathspec` 的既有构建产物；沙箱根 `/tmp/skillbox-accept-journey`（`HOME=/tmp/skillbox-accept-journey/home`、`SKILLBOX_HOME=$HOME/.skillbox`、仓库 `/tmp/skillbox-accept-journey/repo`，另带 `NO_COLOR=1` 并清空 `*_CONFIG_DIR`）。交互步骤（2/3）需要一个真实 TTY（`@clack/prompts`），故用一个 `/tmp` 下的 pty 驱动脚本喂按键，该脚本不属于仓库。

真实用户目录未改动：`~/.skillbox` 的 `find <dir> -maxdepth 1 | wc -l` 前后都是 `6`，`~/.claude/skills` 前后都是 `78`；两次 `ls -ld` 完全一致（`drwxr-xr-x@ 7 … 224 Sep 11 22:19`、`drwxr-xr-x@ 79 … 2528 Sep 18 08:38`），目录 mtime 仍早于本次运行日期，说明运行期间没有任何条目被增删。

### 3.2 仍需本机确认

- **真实 Agent 目录**：第 1/2/3 步用的是手工造的 `$HOME/.claude/skills/*`、`$HOME/.codex/skills/*`（各 2 个含 frontmatter 的 `SKILL.md`）。Claude/Codex/OpenCode 的可执行文件是真的（PATH 上能解析出版本号），但"真实第三方 Agent 既有 Skill"的扫描/迁移/回链要在维护者本机重跑。
- **Credential Store**：沙箱内 `skillbox doctor` 报 `✗ credentials — macOS Keychain unavailable during "add"`（整体 exit 1），Keychain 读写只能在真实登录会话里确认。
- **GitHub Device Flow / 真实 push**：`skillbox connect` 是交互式设备流，无法在沙箱完成。实测到的都是有类型的门禁：无 remote 时 `skillbox: No git remote configured — bind one with \`skillbox connect\` (or \`git remote add origin <url>\`)`；`git init --bare` 造出 origin 后 `skillbox push` → `skillbox: GitHub is not-connected — run \`skillbox connect\` to authorize Skillbox before pushing.`（exit 1）；`skillbox sync` 前半段真实跑通（`scan ok` → `detect ok` → `secret-scan ok` → `pull ok` → `resolve warning（lockfile 重算）` → `commit ok committed 870e0d3`），只在最后一步 `push warning github not-connected`。因此"推到真实 GitHub 私仓 + fresh clone 拉回"仍需本机确认。
- **Windows / Linux**：本轮只在 macOS arm64 跑过；junction/copy link 策略与路径分隔符分支未覆盖。
- **有 remote 但分支尚无 upstream 时**：`skillbox sync` 会停在 pull 步骤并透出 git 原文 `skillbox: git pull failed (exit 1): There is no tracking information for the current branch.`（需要先 `git push -u origin <branch>`；`skillbox push` 本身又被设备流门禁挡住，所以这一步只能在连好账号的本机走通）。

### 3.3 与本文旧预期不符之处（实测）

其中 b 已在本 PR 修复，c 记入 GAP §3.6 作为待决债务；其余是本文旧预期写错了，产品行为即现状。

- **a. 导入结果 `MODE = local` 而非 `managed`**：第 3/4/6 步的旧预期把外部 Skill 写成 `mode: managed`。实测导入写的是 `mode: local` + `source.type: local`，实体落在 `library/local/`；`managed` 只由远程来源推导（`packages/core/src/manifest/schema.ts` 的 `deriveMode`：`local` 源 → `local`，其余 → `managed`）。
- **b. 首启 onboarding 选择 Skip 会终止会话（已修）**：跳过导入后 `onboarding()` 无条件调 `syncNow()` → `install()`，无 `skillbox.yaml` 的空仓库直接抛 `No skillbox.yaml found in "<repo>"`、rc=1；更糟的是 `markOnboarded()` 在其后，标记没写上，所以每次启动都重演一遍。现在仓库无 manifest 时跳过这一步并提示「Nothing to sync yet」，菜单与标记照常到达（回归测试：`session.test.ts > finishes onboarding when the repository has no manifest yet`）。单独执行 `skillbox install` 在空仓库仍然 rc=1 —— 那是显式命令的正当报错，不在本次修复范围。
- **c. 任何写操作都会把 `modified` 吸收进锁基线**：第 9 步看到的 `modified` 会在下一次 `enable`/`disable`（含 Web API，二者都会 `reconcile`）后消失 —— 实测 `skillbox.lock` 的 integrity 被改写成磁盘现状，状态回到 `ready`。CLI 会打一行 `INTEGRITY_MISMATCH …`（Web API 把它放在 `reconcile.problems` 里），但那一行讲的是「锁与磁盘不一致」，不是「即将抹平」，`apps/web` 也没有渲染 `reconcile.problems` 的地方。integrity 验收必须在改动之后、任何写操作之前读取。已记入 GAP §3.6（尚未修）。
- **d. 10a 的响应体形状不同**：实际是 `{"assignment":{"name","agent","manifestChanged","reconcile":{…}}}`，没有旧预期里的 `enabled` 字段。
- **e. 浏览器层未验证**：CDP 工具在本轮不可用，第 10 步只做到"HTTP 200 的页面与 API + manifest 落盘一致"，页面渲染/点击路径仍需人工过一遍。

> 顺带记录一个本分支已修复的坑：仓库里存在 `skillbox.yaml`/`skillbox.lock` 但**没有** `skills/` 目录时，sync 的提交步骤过去会死在 `fatal: pathspec 'skills' did not match any files`。本轮在 `/tmp/skillbox-accept-journey/repo2`（manifest + lock，无 `skills/`）跑 `skillbox sync`，`commit ok committed 870e0d3` 正常通过，未复现该错误。

---

## 4. 相关参考

- MVP_TASKS §98（E2E 验收）
- MVP_TASKS §97（0.1.0 Release Gate）
- `INSTALLATION.md`（构建与运行）
- `scripts/verify-package.mjs`（发布形态验证）
- Web API：`packages/cli/src/web/app.ts`（`/api/health|skills|agents|status|settings|skills/:id/enable|disable`）