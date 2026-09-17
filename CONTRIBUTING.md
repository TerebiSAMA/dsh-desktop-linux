# Contributing

欢迎贡献代码、报告 Bug 或改进文档。

## 开发流程

1. Fork → 新建特性分支
2. 本地跑通：`npm install && npm start`
3. 自检：`npm run pack`（出 unpacked dev 构建，确认启动正常）
4. 提交 PR，标题遵循 `<类型>: <简短描述>`（如 `feat: 添加 macOS 平台支持`）

## 代码规范

- 主进程代码使用 CommonJS（`require` + `module.exports`)
- 不引入新依赖前请在 issue 里讨论
- 改动 `main.js` 的认证逻辑必须保留回退行为（密钥缺失时静默降级，不阻断启动）
- 提交信息清晰简明，单 PR 不超过 300 行有效改动

## 调试

桌面端主进程输出到 stderr。可在终端直接 `npm start` 查看；后台运行时查看
`nohup.out` 或 `journalctl --user`。

调试窗口（不推荐生产环境打开）：在 main.js 里临时加
`mainWindow.webContents.openDevTools({ mode: 'detach' })`。