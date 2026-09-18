# plugins/

DSH Web GUI 客户端插件的**参考备份**——这些不是 Electron 桌面端代码，
而是给 DSH 前端用的 cordis 插件。

> 桌面端本体（main.js / preload.js / 托盘 / 状态栏 / 桌面集成）才是本仓库
> 的主体；这里只是把用户机器上的 DSH profile 插件存档一份，方便以后换
> 机器 / 升级 DSH 时快速重新安装。

## 已收录的插件

| 名称 | 作用 |
|---|---|
| `dsh-client-ui-center-align/` | 修复侧边栏图标 vs 文字的视觉错位（顶部 brand + 新会话/设置按钮） |

## 安装方法

每个子目录里有自己的 `README.md` 说明。通用步骤：

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@deepseek-ai/<plugin-name>/lib
cp <plugin-dir>/package.json ~/.dsh/profiles/web/node_modules/@deepseek-ai/<plugin-name>/
cp <plugin-dir>/lib/*.js ~/.dsh/profiles/web/node_modules/@deepseek-ai/<plugin-name>/lib/

# 在 ~/.dsh/profiles/web/cordis.patch.yml 里加 insert 段
```

升级 DSH 后插件可能因 CSS Modules hash 类名变化失效——参考各插件 README
里的排查方法更新。
