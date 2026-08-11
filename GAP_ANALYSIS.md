# Skillbox 功能差距清单（Gap Analysis）

> 对照 PRD.md / SKILLBOX_SPEC.md / ARCHITECTURE.md / MVP_TASKS.md / idea.md / docs/superpowers/specs/2026-08-09-github-integration-design.md 与当前代码（M0–M11 已实现，HEAD `352403c`）。
> 生成日期：2026-08-09。

## 已实现基线（V0.1 Local Management 核心）

- Core Domain：Skill 四状态（managed/forked/local/vendored）+ 六状态（ready/modified/outdated/conflict/missing/broken）模型
- Manifest（skillbox.yaml）全字段 + 4 种 Source（github/git/registry/local）+ 确定性序列化
- Lockfile（skillbox.lock）全字段（含 `upstream{baseRevision,baseIntegrity,latestRevision}`，schema 已就位）
- Integrity：sha256 canonical hash、.gitattributes（eol=lf）、跨平台一致
- Agent Adapters：Claude Code + Codex（detect/scan/link/unlink）
- Canonical Library（~/.skillbox/library）、symlink/junction 优先 + copy fallback、Ownership Marker
- Import Existing Skills（keep-existing/replace/import-both/skip 冲突处理）
- Reconcile Engine（local source：materialize + link + stale cleanup）
- SkillService / StatusService（create/remove/enable/disable/install/import/edit）
- Basic CLI：list/agents/create/remove/enable/disable/install/status/web
- Interactive CLI（@clack/prompts 菜单）
- Web Server（Hono）+ React 前端（Library/Agents/Settings/CreateSkill/SkillDetail）
- CI 三平台矩阵全绿；核心协议骨架按 SPEC 实现

---

## 1. V0.1 收尾缺口（当前版本范围，未完成）

| #    | 缺口                                                                                             | 证据/位置                                                                                                | 来源                   |
| ---- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1.1  | 交互菜单 "Open Web UI" 是死占位，未启动已实现的 `skillbox web`                                   | `packages/cli/src/interactive/session.ts`（webPlaceholder）、`menu.ts:38`（"placeholder - coming soon"） | MVP_TASKS §74/§72      |
| 1.2  | Settings 页只读，缺 Link Strategy / Web Port / Auto Open Browser / Agent Overrides 设置          | `apps/web/src/pages/SettingsPage.tsx`                                                                    | MVP_TASKS §94、PRD §38 |
| 1.3  | Agents 页卡片不可点击，无 Skill assignment 跳转                                                  | `apps/web/src/pages/AgentsPage.tsx`                                                                      | MVP_TASKS §93          |
| 1.4  | Create Skill 表单缺 Agent Assignment 字段                                                        | `apps/web/src/pages/CreateSkillPage.tsx`                                                                 | MVP_TASKS §92          |
| 1.5  | Logging（`--verbose`/`--debug` 三级日志）未实现                                                  | 全仓 grep `verbose\|debug\|logger` 零命中                                                                | MVP_TASKS §184         |
| 1.6  | 发布资产缺失：README / INSTALLATION / CONTRIBUTING / LICENSE；各包 `"private": true` 未配置发布  | 仓库根 package.json                                                                                      | MVP_TASKS §187/§223    |
| 1.7  | 0.1.0 E2E 验收（10 步流程）无自动化                                                              | 无 e2e 目录                                                                                              | MVP_TASKS §98          |
| 1.8  | Cursor Adapter（P1，文档允许延后 0.1.1）                                                         | `packages/core/src/agent/registry.ts` 仅 claude/codex                                                    | MVP_TASKS §41          |
| 1.9  | Agent Path Overrides 形状：SPEC 要求 `agents.<id>.skillDirectories: [数组]`，实现为单字符串 path | `packages/core/src/runtime/config.ts`                                                                    | SPEC §128              |
| 1.10 | Machine Config 缺 `web.host`（SPEC config.json 示例含 web.host/web.openBrowser）                 | config schema                                                                                            | SPEC §158              |

## 2. V0.2 — Git Sync（PRD 核心功能，GitHub 集成 spec 已 Approve，完全未动工）

### 2.1 Git Engine（core 无 git 模块）

- GitClient：init/status/pull/commit/push/diff/冲突检测（系统 Git 子进程封装）
- `reconcile/engine.ts:122-129` 硬编码跳过远程 source；`status-service.ts:110-114` "cannot be materialized in wave 1" —— 需移除
- 错误码 `GIT_NOT_FOUND` 已预留，无调用处

### 2.2 GitHub 集成（ARCHITECTURE §15.2/ADR-016~019、SPEC §123-125、specs/2026-08-09-github-integration-design.md）

- GitHub App Device Flow 授权轮询（5 种授权状态：not-connected/authorizing/connected/refresh-required/reauthorization-required）
- OS Credential Store 抽象：macOS Keychain / Windows Credential Manager / Linux Secret Service
- Token 生命周期：get/set/delete/refresh；token 禁止进 remote URL/.git/config/manifest/lockfile/日志/debug bundle
- 创建/选择 Private Repository（默认 `skillbox-skills`、private、main；幂等可重试）
- HTTPS Credential Bridge：临时注入 system Git 子进程，不落盘
- Disconnect：只删本地凭据，不动仓库/remote/skills
- 配置：config.json 存 github.connected/login/provider/repository（token 禁止）

### 2.3 Sync 流水线与 Multi-device

- `skillbox sync`：Scan → Detect → Secret Scan → Pull → Resolve → Commit → Push
- `skillbox status/pull/push` 高级命令
- Multi-device Restore：git clone → `npx skillbox install` 恢复 Local/Forked/Vendored + 重下 Managed + Agent Assignment
- `install --frozen-lockfile / --ci` + `LOCKFILE_OUTDATED` 错误；lockfile missing 提示

### 2.4 Secret Scan（SPEC §160、MVP_TASKS §112-117）

- Pattern scanner（.env/_.pem/_.key/API keys/Bearer/Private Key），只扫 changed files
- Severity 分级：Critical/High→Block、Medium→Warning、Low→Info
- Ignore once / Add to Ignore（secret policy）

### 2.5 `.skillboxignore`（SPEC §106-109、§154、§156）

- 控制导入/同步/扫描/备份忽略；语法兼容 .gitignore；匹配文件不参与 Integrity

## 3. V0.3 — Marketplace / Registry / Updates

- Registry Service + Provider 框架（`registries/` 目录缺失）：GitHubProvider / SkillsShProvider / LocalProvider（未来 GitProvider/GitLabProvider/PrivateRegistryProvider）
- `skillbox search`（skills.sh + GitHub 双源，Registry Agnostic）
- `skillbox add <source>`：source@path 解析 → 安全审查 → 选择安装目标 agent（§5.2 用户故事）
- Remote Install 事务：Resolve → Download to tmp → Validate → Security Scan → Integrity → Move to Runtime → Write Manifest/Lock → Link → 失败 Rollback
- Managed cache（`~/.skillbox/cache/` 按 source-hash/revision/integrity）+ `cache clean`
- Source Normalization（SPEC §23）：`github:org/repo` 与 `https://github.com/org/repo` 归一化
- Updates：`skillbox outdated` / `update`（Managed 直接升级 + lockfile revision/integrity 更新）
- outdated / conflict 状态计算（StatusService 现只产 ready/modified/missing/broken 四种）
- Web Explore 页（Trending/Official/Popular/Recently Updated/Security Reviewed）+ Skill Install Page

## 4. V0.4 — Skill Lifecycle（Fork / Vendor / Diff / Merge）

- `skillbox fork`：Managed→Forked（materialize → copy → upstream/base revision → 更新 manifest+lockfile）
- `skillbox vendor`：Managed/Forked→Vendored（localize、清除 upstream）
- Managed Edit → Fork 自动转换：外部修改检测提示 "[Convert to Fork]/[Restore Upstream]"（SPEC §92-93）
- Base Snapshot：`.skillbox/bases/<alias>/<rev>/`（SPEC §58-60）
- `skillbox diff`：Managed（Current vs Latest）/ Forked（Base/Local/Upstream）双视图
- 3-way Merge：BASE/LOCAL/UPSTREAM，冲突 → `status=conflict` 且禁止更新 baseRevision；二进制不自动 merge
- Rollback（PRD §42）
- 状态转换状态机（非法转换禁止）

## 5. 安全层（P1，跨阶段）

- Skill Security Scanner：安装前扫描 shell 执行/网络/文件写入/凭证访问/curl|bash/rm -rf/PowerShell 等，输出 Risk 等级（lockfile `security:{risk,scannedAt}` 字段已预留）
- Web Security UI：安装前风险展示 + [Review]/[Install]
- 与 Marketplace `add` 流程集成

## 6. 架构级基础设施（ARCHITECTURE.md 规划未落地）

- Event Bus（`events/event-bus.ts`）：SkillDownloadStarted/Installed/GitSync/SecurityFinding
- Platform Layer：`platform/windows.ts|macos.ts|linux.ts`（含 `openUrl()`）
- 运行锁 `runtime.lock`（防并发 sync 损坏 Repository/Lockfile）
- Backup 机制：`~/.skillbox/backups/`（Merge/Vendor/Remove modified/Restore 前）
- Logging + `--debug`：`~/.skillbox/logs/`，不记录 secret/token；debug bundle 脱敏（0.2 前置）
- Schema Migration：Manifest/Lockfile schema 版本化迁移 + `skillbox migrate`
- Copy 链接策略下的 sync metadata 维护
- 独立 `packages/tui` 全屏 TUI（架构推荐，当前为 @clack/prompts Interactive CLI）
- 独立 `packages/web-server` 包（架构推荐前后端解耦，当前内置在 cli 包）
- `skillbox doctor` / debug bundle（MVP_TASKS §185-186）

## 7. Agent 覆盖面扩展

- Cursor / Gemini CLI / OpenCode / Windsurf / GitHub Copilot 适配器（架构规划 5 个，仅实现 2 个）
- Agent Capability Model 的 UI 应用（能力展示与选项联动未落地）

## 8. 明确不做（Non-goals / 范围护栏）

自有 Registry、SaaS 云盘/Remote Dashboard、新 Skill 标准、强制桌面客户端（PRD §46）；MCP/Rules/Prompts/Hooks 管理、Team/Billing/RBAC/Cloud Database、Project-scope skills、Presets、Gist 轻量分享、AI 生成技能（idea.md 未规划）、Plugin 注册机制（均标注为未来/长期）。

## 9. 已知小差异

- Manifest 注释保留与未知字段 round-trip（SPEC §122/§149-150，MVP 允许重写）
- Lockfile Security Metadata 字段（V0.3 用）
- Executable bit 记录（v1 可不做）

---

## 实施路线建议

1. **波次 1（0.1 收尾，可并行）**：§1.1-1.8 —— 成本低、风险小、独立无冲突
2. **波次 2（V0.2 Git Sync）**：Git Engine → Credential Store → Device Flow → Repository 编排 → Sync 流水线 → Secret Scan → Multi-device E2E（spec 已 Approve，最大模块）
3. **波次 3（V0.3）**：Registry 框架 → Remote Install 事务 → search/add → Updates
4. **波次 4（V0.4 + 安全）**：Fork/Vendor → Diff → 3-way Merge → Security Scanner

依赖关系：V0.3/V0.4 依赖 V0.2 的远程能力（拿 upstream 仓库）；Security Scanner 建议与 `add` 流程一起做。
