# dsh-client-ui-center-align

GUI 客户端插件：修正 DSH Web 侧边栏里**图标和文字的视觉错位**。

## 修了什么

排查发现两个垂直错位点：

1. **顶部 brand（logo + DSH Desktop 文字）**：中间层 `.hHd-Xa_brandIdentity` 用
   `align-items: center`，logo（h=17.65）和文字（h=24）中心对齐 → logo 顶部 y=27、
   文字顶部 y=24，**logo 比文字下沉约 3px**。
   → 改为 `flex-start` 让两者顶部对齐 y=24。

2. **"新会话"/设置 按钮**：svg 渲染 14-16px，文字 22 高，中心对齐后
   **图标小、文字大，图标像陷在文字中间**。
   → 把 svg 放大到 22×22（viewBox 16:16 等比 → 内容占满、不裁剪），
   图标和文字等高。

## 安装

插件是 DSH Web GUI 的客户端插件，**不是 Electron 桌面端代码**，所以要装到
DSH profile 而不是桌面端应用本身：

```bash
# 1. 复制到 DSH profile 的 node_modules
mkdir -p ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-center-align/lib
cp package.json ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-center-align/
cp lib/*.js ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-center-align/lib/

# 2. 在 cordis.patch.yml 里挂载（追加一段）
cat >> ~/.dsh/profiles/web/cordis.patch.yml << 'EOF'

# 侧边栏图标 vs 文字的视觉错位修复
- insert:
    - id: ui-center-align
      name: '@deepseek-ai/dsh-client-ui-center-align'
EOF
```

然后重启 DSH Web 服务 / 桌面端，让 GUI 重新加载插件。

## 升级 DSH 后可能失效

CSS 选择器用了上游 CSS Modules 的 hash 类名（`hHd-Xa_*` / `VOzbGW_*`），
这些类名在当前 DSH 版本内稳定。**升级 DSH 后 hash 变了需要重新排查更新**
——用 Electron 桌面端的 DevTools (--remote-debugging-port) 检查实际类名，
替换本插件 CSS 即可。

## 排查方法

桌面端启动时带 `--remote-debugging-port=9222`，然后用 Node 连 CDP：

```bash
node - << 'EOF'
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/<id>');
// Runtime.evaluate { expression: '...' } 查 .hHd-Xa_brand 等元素的
// getBoundingClientRect / getComputedStyle 找出垂直偏移
EOF
```

或者直接打开 Chromium DevTools 连 9222 端口手动看。

## 跟桌面端项目的关系

这个插件的代码**不打包进桌面端 .asar**，它只是 DSH profile 端的客户端插件。
仓库里保存一份纯粹做参考备份，方便以后换机器 / 升级 DSH 时快速重装。
