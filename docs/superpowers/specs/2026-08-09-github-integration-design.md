# Skillbox GitHub Integration Design

> Status: Approved
> Date: 2026-08-09

## Decision

Skillbox 0.2 将 GitHub 账号连接升级为 P0：

> Git 是 Skillbox 的同步协议，GitHub 是 Skillbox 的默认云端 Provider。

GitHub Integration 与 Git Engine 必须分层。GitHub Integration 负责身份认证、用户与 Repository API、token 生命周期；Git Engine 继续通过 System Git 负责 init、fetch、pull、commit、merge、push 和 status。

## Default User Flow

```text
Connect GitHub
→ GitHub App Device Flow
→ Create a private repository or select an existing repository
→ Initialize and bind local Git
→ Initial commit and push
→ Sync enabled
```

Advanced Git remote 保留为完整支持的入口，可使用 SSH、HTTPS、Git Credential Manager、`gh`、GitLab、Gitea 或 self-hosted Git，不要求 Skillbox GitHub 登录。

## Security Model

- 公开 NPM CLI 只包含 Client ID，不包含 Client Secret。
- GitHub App 权限最小化为 Metadata read、Contents read/write，以及创建 Repository 所需的 Administration write。
- Access token 与 refresh token 只存入 macOS Keychain、Windows Credential Manager 或 Linux Secret Service。
- 普通配置只保存 login、provider、repository 等非敏感元数据。
- Git HTTPS 操作通过临时 credential bridge 向 System Git 提供 token。
- Token 不得进入 remote URL、`.git/config`、Manifest、Lockfile、日志、错误或 debug bundle。

## Provider Scope

V0.2 默认支持 GitHub Private Repository，并保留 Generic Git 高级模式。Gist 不进入默认路径；Secret Gist 不等同于 private storage，也不适合完整且持续增长的 Skill workspace。

## Failure and Data Safety

Repository 创建与首次同步必须幂等、可重试。Disconnect 只清除本机凭证与连接元数据，不删除本地 Repository、远程 Repository、Git remote 或 Skills。

## Documentation Impact

- `PRD.md` 定义产品流程、Provider 定位、0.2 范围和成功标准。
- `ARCHITECTURE.md` 定义 GitHub Integration、Repository Service、CredentialStore 与 Git Engine 边界。
- `SKILLBOX_SPEC.md` 定义机器本地连接状态、凭证不变量、认证优先级和断开语义。
- `MVP_TASKS.md` 将 Device Flow、CredentialStore、Repository API、Git credential bridge 和端到端测试拆为 0.2 P0 任务。

## Acceptance

普通用户必须能从首次运行完成 Connect GitHub、创建默认私有仓库和首次同步，无需手动创建 Repository、复制 remote URL 或再次配置 Git 登录。高级用户必须仍可完全绕过 GitHub Integration 使用 Generic Git。
