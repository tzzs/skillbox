# Skillbox P1/P2 全量实施计划

> 设计：`docs/superpowers/specs/2026-08-13-all-p1-p2-implementation-design.md`
>
> 执行原则：每项变更先有可失败的测试；每批次独立 PR；后续批次只消费已验证的 Core 合约。

## Batch 1 — OperationRuntime 与用户级恢复

1. 新建 `packages/core/src/operations/{types,lock,journal,snapshot,backup-index,runtime,index}.ts`。
   - repository-scoped exclusive lock、owner/stale recovery；versioned journal；幂等 snapshot restore；
     backup retention；阶段 fault injection。
2. 扩展 `FilesystemService` 的 exclusive write primitive、runtime path layout、error codes 和 Core exports。
3. 先完成 `operations/*.test.ts`：锁竞争、损坏/未完成 journal、边界安全 snapshot、跨仓库/过期
   rollback、每阶段 fault injection。
4. 迁移 Managed Restore；保持 cache-only source 行为，新增 runtime snapshot、link target 恢复和
   crash residue preflight 测试。
5. 暴露 Core/CLI `rollback`，并以同 repository、完整、未过期 record 为强制前置条件。
6. 后续 Batch 1 子批依次迁移 Fork、Vendor、Remove、Merge；仅在新测试覆盖后删除局部 rollback。

## Batch 2 — SkillSourceResolver 与完整 Lifecycle

1. 新建 `packages/core/src/sources/`：canonical union、resolver、GitHub/Git/Registry/Local adapters。
2. 为 Manifest/Lockfile source 建立无损 round-trip contract；新增字段只向后兼容读取/写入。
3. 按 Install/Update → Reconcile → Diff/Merge → Restore → CLI Marketplace → Web 的顺序迁移。
4. Restore cache miss 必须只 materialize 锁定 revision、验证 integrity、修复 Skillbox-owned links；
   禁止以 latest 替代锁定 pin。
5. 移除 `defaultRegistry`、重复 source union、动态 shape bridge 前，完成双路径回归测试。

## Batch 3 — E2E 与平台验收

1. 建立 `packages/testing/src/{cli-harness,git-fixture,http-fixture}.ts` 和 `tests/e2e/`。
2. 以打包 CLI 子进程、临时 HOME、bare remote、受控 HTTP 覆盖 lifecycle/sync/registry/security 旅程。
3. 在 CI 分离快速单测、E2E 与 pack/install；处理 Windows cleanup race，不静默忽略 flake。
4. 将 Windows/macOS/Linux 的人工证据写入 `docs/e2e-evidence/` 并更新 E2E 验收文档。

## Batch 4 — Web、web-server 与 Fullscreen TUI

1. 先固定 Core-backed lifecycle/rollback API contract。
2. 将 Hono service 从 CLI 提取为 `packages/web-server`，CLI 仅保留薄 command；更新打包资产位置。
3. 实现 Web Fork/Vendor/Edit/Restore/Merge/Continue/Abort/Rollback UI，复用 API result/error/progress。
4. 实现 Fullscreen TUI，复用 CLI service facade 和相同确认/错误语义。

## Batch 5 — 诊断、迁移、发布与 Agent 扩展

1. 基于 OperationRuntime 添加 migration registry、`skillbox migrate`、progress/event bus、业务日志。
2. 实现 Core diagnostics、`skillbox doctor`、脱敏 debug bundle 与泄漏回归测试。
3. 抽取 Agent conformance suite 并实现 Gemini CLI、OpenCode、Windsurf、GitHub Copilot adapters。
4. 完成 package metadata、workspace 发布重写、pack/install smoke、release workflow 与 dry run。

## 每批次门禁

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

影响 npm 发布内容时追加 `pnpm pack` 与干净临时安装。发布还要求自动 E2E、安全脱敏、三平台
人工证据、文档一致性及无未恢复 journal/lock。
