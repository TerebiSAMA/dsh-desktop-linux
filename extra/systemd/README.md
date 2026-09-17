# extra/systemd

可选的 systemd 用户单元模板，让 DSH Web 服务随登录自动启动。

## 安装

```bash
mkdir -p ~/.config/systemd/user
cp extra/systemd/dsh-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-web
```

确认状态：

```bash
systemctl --user status dsh-web
```

## 说明

- `WorkingDirectory=%h` 展开为当前用户的家目录，所以同一份单元在不同机器/用户都能用。
- `ExecStart=%h/.local/bin/dsh web --no-open` 假设你已经用 `npm install -g @deepseek-ai/dsh`
  把 `dsh` 装到了 `~/.local/bin/`。如果你用的是 pnpm 或 yarn global，把路径换掉。
- `--no-open` 让服务启动时不自动开浏览器——桌面端是主 UI，避免抢焦点。
- 想要禁用自动启动：`systemctl --user disable --now dsh-web`