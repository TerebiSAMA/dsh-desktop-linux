# Security Policy

## Supported versions

| 版本  | 支持情况       |
|-------|--------------|
| 0.2.x | ✅ 活跃支持    |
| 0.1.x | ❌ 不再维护    |

## 报告漏洞

请**不要**通过公开 Issue 报告安全问题。

发邮件到：<terebisama@users.noreply.github.com>（GitHub noreply 邮箱不直接接收邮件，
请改用 GitHub 私信或开启一个 Private Security Advisory：

1. 仓库页 → Security tab → "Report a vulnerability"
2. 按 GitHub 流程走，会私下联系维护者

## 安全模型要点

- 桌面端只加载本地 `127.0.0.1:3080`，外部链接转交系统浏览器
- 渲染进程 `contextIsolation + sandbox + no nodeIntegration`
- preload 桥按白名单暴露 IPC，所有 URL 校验同源（127.0.0.1 / localhost）
- 自认证 cookie 仅基于 `~/.dsh/.credentials.yaml` 里 DSH Web 自己写的密钥
- 桌面端不会上传任何遥测

## 已知非安全问题

- 自动更新走 HTTPS（GitHub Releases）
- AppImage 暂未签名（请通过校验和验证）；deb/rpm 后续会加 GPG 签名