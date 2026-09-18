#!/usr/bin/env bash
# install.sh — 一键准备 DSH Desktop Linux 的所有依赖。
#
# 默认只做"必需"的准备（DSH 后端 + GUI 客户端插件 + 首次起一次让
# credentials 落地）。可选步骤通过 flag 启用：
#
#   --with-systemd   安装并启用 systemd 用户单元（DSH Web 后台守护，
#                    失败自动重启。推荐用于长时间挂着的桌面环境）
#   --with-autostart 安装 XDG autostart 桌面项（开机启动桌面端）
#   --no-launch      不自动起 dsh web（自己控制时机）
#
# 一行安装：
#   curl -fsSL https://raw.githubusercontent.com/TerebiSAMA/dsh-desktop-linux/main/install.sh | bash -s -- --with-systemd
#
# 也可以克隆后本地跑：
#   git clone https://github.com/TerebiSAMA/dsh-desktop-linux.git
#   cd dsh-desktop-linux && bash install.sh --with-systemd
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
PROFILE_DIR="$HOME/.dsh/profiles/web/node_modules/@deepseek-ai"
PATCH_FILE="$HOME/.dsh/profiles/web/cordis.patch.yml"
SYSTEMD_DIR="$HOME/.config/systemd/user"
AUTOSTART_DIR="$HOME/.config/autostart"

WITH_SYSTEMD=0
WITH_AUTOSTART=0
NO_LAUNCH=0
for arg in "$@"; do
  case "$arg" in
    --with-systemd)   WITH_SYSTEMD=1 ;;
    --with-autostart) WITH_AUTOSTART=1 ;;
    --no-launch)      NO_LAUNCH=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()  { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '    \033[1;33m!\033[0m %s\n' "$*" >&2; }

# ---------- 1. DSH 后端 ----------
say "安装 DSH 后端 (@deepseek-ai/dsh)"
if command -v dsh >/dev/null 2>&1; then
  ok "已存在: $(command -v dsh) → $(dsh --version 2>/dev/null || echo '?')"
else
  if ! command -v npm >/dev/null 2>&1; then
    warn "找不到 npm，请先装 Node.js（https://nodejs.org/）"
    exit 1
  fi
  if npm install -g @deepseek-ai/dsh; then
    ok "已装: $(command -v dsh || echo "$HOME/.local/bin/dsh")"
  else
    warn "npm install -g 失败，尝试 pkexec 提权"
    if command -v pkexec >/dev/null 2>&1; then
      pkexec npm install -g @deepseek-ai/dsh && ok "已装（提权）"
    else
      warn "提权安装也失败，请手动执行: sudo npm install -g @deepseek-ai/dsh"
      exit 1
    fi
  fi
fi

# ---------- 2. 桌面端开发依赖（仅源码运行场景）----------
if [ -f "$REPO_ROOT/package.json" ] && grep -q '"name": "dsh-desktop-linux"' "$REPO_ROOT/package.json" 2>/dev/null; then
  say "安装桌面端开发依赖（npm install）"
  ( cd "$REPO_ROOT" && npm install --no-audit --no-fund ) && ok "桌面端依赖 OK"
fi

# ---------- 3. DSH profile GUI 客户端插件 ----------
if [ -d "$REPO_ROOT/plugins" ]; then
  say "安装 GUI 客户端插件到 DSH profile"
  mkdir -p "$PROFILE_DIR"
  for plugin_dir in "$REPO_ROOT/plugins"/*/; do
    [ -d "$plugin_dir" ] || continue
    name=$(basename "$plugin_dir")
    target="$PROFILE_DIR/$name"
    mkdir -p "$target/lib"
    cp "$plugin_dir/package.json" "$target/"
    cp "$plugin_dir/lib/"*.js "$target/lib/"
    ok "$name"
  done

  # 追加 cordis.patch.yml insert 段（id = ui-<plugin-name 去掉 dsh-client-ui- 前缀>）
  if [ -d "$(dirname "$PATCH_FILE")" ] || mkdir -p "$(dirname "$PATCH_FILE")"; then
    if [ ! -f "$PATCH_FILE" ]; then
      printf '# dsh profile 的 cordis patch 层（由 dsh-desktop-linux install.sh 初始化）\n' > "$PATCH_FILE"
    fi
    for plugin_dir in "$REPO_ROOT/plugins"/*/; do
      [ -d "$plugin_dir" ] || continue
      name=$(basename "$plugin_dir")
      id="ui-${name#dsh-client-ui-}"
      if grep -q "id: $id" "$PATCH_FILE" 2>/dev/null; then
        ok "cordis: $id 已注册"
      else
        printf '\n# 来自 dsh-desktop-linux: %s\n- insert:\n    - id: %s\n      name: '\''@%s'\''\n' \
          "$name" "$id" "$name" >> "$PATCH_FILE"
        ok "cordis: $id 已注册"
      fi
    done
  else
    warn "无法写入 $PATCH_FILE，跳过插件注册（插件文件已拷贝，可手动 patch）"
  fi
fi

# ---------- 4. systemd 用户单元 ----------
if [ "$WITH_SYSTEMD" = 1 ]; then
  say "安装 systemd 用户单元（DSH Web 后台守护）"
  if [ -d "$REPO_ROOT/extra/systemd" ]; then
    mkdir -p "$SYSTEMD_DIR"
    for svc in "$REPO_ROOT/extra/systemd"/*.service; do
      [ -f "$svc" ] || continue
      unit=$(basename "$svc")
      cp "$svc" "$SYSTEMD_DIR/"
      ok "$unit"
    done
    systemctl --user daemon-reload
    if systemctl --user enable dsh-web.service 2>/dev/null; then
      ok "已 enable dsh-web.service"
    fi
    if systemctl --user restart dsh-web.service 2>/dev/null; then
      ok "已 restart dsh-web.service"
    else
      warn "systemctl --user restart 失败，可能 lingering 没开；用 'loginctl enable-linger $USER' 开启"
    fi
  else
    warn "$REPO_ROOT/extra/systemd 不存在，跳过"
  fi
fi

# ---------- 5. XDG autostart ----------
if [ "$WITH_AUTOSTART" = 1 ]; then
  say "安装 XDG autostart（开机启动桌面端）"
  if [ -d "$REPO_ROOT/extra/autostart" ]; then
    mkdir -p "$AUTOSTART_DIR"
    for f in "$REPO_ROOT/extra/autostart"/*.desktop; do
      [ -f "$f" ] || continue
      cp "$f" "$AUTOSTART_DIR/"
      ok "$(basename "$f")"
    done
    warn "autostart 模板里的 Exec 是占位（/usr/bin/true），请改成真实的桌面端可执行路径"
  else
    warn "$REPO_ROOT/extra/autostart 不存在，跳过"
  fi
fi

# ---------- 6. 首次启动 dsh web 让 credentials 落地 ----------
if [ "$NO_LAUNCH" = 1 ]; then
  say "跳过首次启动 dsh web（--no-launch）"
else
  say "首次启动 dsh web（落地 credentials.yaml）"
  if ! curl -sf -o /dev/null http://127.0.0.1:3080/ 2>/dev/null; then
    if command -v dsh >/dev/null 2>&1; then
      ( nohup dsh web --no-open >/dev/null 2>&1 & echo $! > /tmp/dsh-install.pid ) || true
      for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        sleep 1
        if curl -sf -o /dev/null http://127.0.0.1:3080/ 2>/dev/null; then
          ok "DSH Web 已起 (端口 3080)"
          break
        fi
      done
      if [ -f /tmp/dsh-install.pid ]; then
        kill "$(cat /tmp/dsh-install.pid)" 2>/dev/null || true
        rm -f /tmp/dsh-install.pid
      fi
      if [ -f "$HOME/.dsh/.credentials.yaml" ]; then
        ok "credentials.yaml 已落地（桌面端可免 token 认证）"
      else
        warn "DSH Web 没起来 / credentials 未落地，请手动 'dsh web' 跑一次"
      fi
    else
      warn "找不到 dsh 命令，跳过首次启动"
    fi
  else
    ok "DSH Web 已在跑（端口 3080）"
  fi
fi

cat <<'EOF'

✓ 准备完成。

下一步：
  - 双击桌面图标 / 运行已下载的 AppImage/deb/rpm
  - 或者从源码运行：cd 仓库 && npm start
  - 或用 --with-systemd 时：systemctl --user status dsh-web 看后台服务

EOF
