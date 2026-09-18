#!/usr/bin/env bash
# install.sh — 一键准备 DSH Desktop Linux 的所有依赖。
#
# 默认只做"必需"的准备（DSH 后端 + GUI 客户端插件 + 首次起一次让
# credentials 落地）。可选步骤通过 flag 启用：
#
#   --with-systemd    安装并启用 systemd 用户单元（DSH Web 后台守护，
#                     失败自动重启。推荐用于长时间挂着的桌面环境）
#   --with-autostart  安装 XDG autostart 桌面项（开机启动桌面端）
#   --with-lan-proxy  安装 LAN 反向代理（让 dsh 从局域网内可访问）
#                     搭配 --lan-host=<本机 LAN IP> 和 --lan-client=<允许访问的 IP>
#   --no-launch       不自动起 dsh web（自己控制时机）
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
WITH_LAN_PROXY=0
NO_LAUNCH=0
LAN_HOST=""
LAN_CLIENT=""
for arg in "$@"; do
  case "$arg" in
    --with-systemd)   WITH_SYSTEMD=1 ;;
    --with-autostart) WITH_AUTOSTART=1 ;;
    --with-lan-proxy) WITH_LAN_PROXY=1 ;;
    --lan-host=*)     LAN_HOST="${arg#--lan-host=}" ;;
    --lan-client=*)   LAN_CLIENT="${arg#--lan-client=}" ;;
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

# ---------- 7. LAN 反向代理（--with-lan-proxy） ----------
if [ "$WITH_LAN_PROXY" = 1 ]; then
  say "安装 LAN 反向代理（dsh-lan-proxy）"
  if [ -z "$LAN_HOST" ] || [ -z "$LAN_CLIENT" ]; then
    warn "缺少 --lan-host=<本机LAN IP> 或 --lan-client=<允许访问的客户端 IP>"
    warn "  示例: install.sh --with-lan-proxy --lan-host=<本机LAN IP> --lan-client=<允许访问的 IP>"
    warn "  跳过 LAN 代理安装"
  elif [ -d "$REPO_ROOT/tools" ] && [ -f "$REPO_ROOT/tools/dsh-lan-proxy.js" ]; then
    # 装脚本
    sudo install -m755 "$REPO_ROOT/tools/dsh-lan-proxy.js" /usr/local/lib/dsh-desktop-linux/dsh-lan-proxy.js
    sudo install -m755 "$REPO_ROOT/tools/dsh-lan-proxy-env.sh" /usr/local/bin/dsh-lan-proxy-env
    sudo mkdir -p /usr/local/lib/dsh-desktop-linux
    # 装 systemd unit（替换占位符）
    mkdir -p "$HOME/.config/systemd/user"
    sed -e "s|<LAN_IP>|$LAN_HOST|g" "$REPO_ROOT/extra/systemd/dsh-lan-proxy.service" \
      | sed -e "s|<CLIENT_IP>|$LAN_CLIENT|g" \
      > "$HOME/.config/systemd/user/dsh-lan-proxy.service"
    cp "$REPO_ROOT/extra/systemd/dsh-lan-proxy-env.service" "$HOME/.config/systemd/user/"
    ok "systemd 单元已写好: ~/.config/systemd/user/dsh-lan-proxy.service"
    ok "  DSH_LAN_HOST=$LAN_HOST  DSH_ALLOWED_REMOTE=$LAN_CLIENT"

    # 让 dsh 信任 LAN 端（drop-in）
    if [ -d "$HOME/.config/systemd/user/dsh-web.service.d" ] || mkdir -p "$HOME/.config/systemd/user/dsh-web.service.d"; then
      sed -e "s|<LAN_IP>|$LAN_HOST|g" \
        "$REPO_ROOT/extra/systemd/dsh-web.service.d/public-bind.conf.example" \
        > "$HOME/.config/systemd/user/dsh-web.service.d/public-bind.conf"
      ok "dsh-web drop-in: ~/.config/systemd/user/dsh-web.service.d/public-bind.conf"
    fi

    # 启用并启动
    systemctl --user daemon-reload
    systemctl --user enable --now dsh-lan-proxy-env.service 2>/dev/null && ok "dsh-lan-proxy-env.service 已启用"
    systemctl --user enable --now dsh-lan-proxy.service 2>/dev/null && ok "dsh-lan-proxy.service 已启用"
    systemctl --user restart dsh-web.service 2>/dev/null && ok "dsh-web.service 已重启（加载 --trusted-host）"

    # firewalld 提示
    if command -v firewall-cmd >/dev/null 2>&1; then
      echo ""
      echo "    firewalld: 如果还没给 5080 端口加白名单，建议执行："
      echo "      sudo firewall-cmd --permanent --add-rich-rule='rule family=\"ipv4\" source address=\"$LAN_CLIENT\" port port=\"5080\" protocol=\"tcp\" accept'"
      echo "      sudo firewall-cmd --reload"
      echo ""
      echo "    设置页里的"LAN 访问 — IP 白名单"分区需要桌面端 v0.2.1+（preload 暴露了"
      echo "    dshDesktop.lanAllowlist IPC）。如果是新装的桌面端，关闭再重开一次即可。"
    fi
  else
    warn "找不到 tools/dsh-lan-proxy.js（仓库结构不对？），跳过"
  fi
fi

# ---------- 8. 桌面图标（~/Desktop/dsh-desktop-linux.desktop） ----------
# 期望在没有 X server 的服务器上也能跑，所以只在桌面目录真的存在时才生成。
# 桌面目录遵循 XDG 标准，且不同语言 locale 下名字不同（~/Desktop / ~/桌面 /
# ~/Bureau / ...），用 xdg-user-dir 找最稳。
say "在桌面生成 DSH Desktop 图标"
DESKTOP_DIR="$HOME/Desktop"
if command -v xdg-user-dir >/dev/null 2>&1; then
  XDG_DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null)"
  if [ -n "$XDG_DESKTOP" ] && [ "$XDG_DESKTOP" != "$HOME" ] && [ -d "$XDG_DESKTOP" ]; then
    DESKTOP_DIR="$XDG_DESKTOP"
  fi
fi
# fallback：常见 locale 名字
if [ ! -d "$DESKTOP_DIR" ]; then
  for candidate in "$HOME/Desktop" "$HOME/桌面" "$HOME/Bureau" "$HOME/Schreibtisch"; do
    if [ -d "$candidate" ]; then DESKTOP_DIR="$candidate"; break; fi
  done
fi
if [ ! -d "$DESKTOP_DIR" ]; then
  warn "找不到桌面目录（headless 环境？），跳过桌面图标"
else
  # 检测可执行文件（按优先级）
  DETECTED_EXEC=""
  for c in "/opt/DSH Desktop/dsh-desktop-linux" \
           "/usr/bin/dsh-desktop-linux" \
           "/usr/local/bin/dsh-desktop-linux" \
           "$HOME/.local/bin/dsh-desktop-linux"; do
    if [ -x "$c" ]; then DETECTED_EXEC="$c"; break; fi
  done
  if [ -z "$DETECTED_EXEC" ]; then
    for a in "$HOME"/Applications/DSH-Desktop-*.AppImage \
             "$HOME"/Apps/DSH-Desktop-*.AppImage \
             "$HOME"/.local/bin/DSH-Desktop-*.Appimage; do
      if [ -x "$a" ]; then DETECTED_EXEC="$a"; break; fi
    done
  fi

  # 如果 Exec 路径含空格（或类似不安全字符），XDG 规范会把 Exec 按空格
  # 分隔解析，破坏启动。最稳的做法是软链到无空格路径 ~/.local/bin/，
  # 让 Exec 指向这个链接。
  if [ -n "$DETECTED_EXEC" ] && [[ "$DETECTED_EXEC" =~ [[:space:]\"\'\\\$\`] ]]; then
    LINK_DIR="$HOME/.local/bin"
    LINK_PATH="$LINK_DIR/dsh-desktop-linux"
    mkdir -p "$LINK_DIR"
    if [ -L "$LINK_PATH" ] || [ -e "$LINK_PATH" ]; then
      rm -f "$LINK_PATH"
    fi
    ln -s "$DETECTED_EXEC" "$LINK_PATH"
    ok "原 Exec 路径含空格，已建软链: $LINK_PATH → $DETECTED_EXEC"
    DETECTED_EXEC="$LINK_PATH"
  fi

  # 准备图标（拷到 ~/.local/share/icons 供桌面环境读取）
  ICON_DIR="$HOME/.local/share/icons"
  ICON_FILE="$ICON_DIR/dsh-desktop-linux.png"
  if [ -f "$REPO_ROOT/assets/icon512.png" ]; then
    mkdir -p "$ICON_DIR"
    cp "$REPO_ROOT/assets/icon512.png" "$ICON_FILE"
  elif command -v curl >/dev/null 2>&1; then
    mkdir -p "$ICON_DIR"
    if ! curl -fsSL -o "$ICON_FILE" \
        "https://raw.githubusercontent.com/TerebiSAMA/dsh-desktop-linux/main/assets/icon512.png" 2>/dev/null; then
      ICON_FILE=""
    fi
  else
    ICON_FILE=""
  fi

  # 写 .desktop 文件
  DESKTOP_FILE="$DESKTOP_DIR/dsh-desktop-linux.desktop"
  if [ -n "$DETECTED_EXEC" ]; then
    cat > "$DESKTOP_FILE" <<EOF2
[Desktop Entry]
Type=Application
Name=DSH Desktop
GenericName=DeepSeek Harness Desktop
Comment=DeepSeek Harness desktop client for Linux
Exec=$DETECTED_EXEC
Icon=${ICON_FILE:-dsh-desktop-linux}
Terminal=false
Categories=Development;
StartupWMClass=DSH Desktop
EOF2
    chmod +x "$DESKTOP_FILE"
    ok "桌面图标: $DESKTOP_FILE"
    ok "  Exec = $DETECTED_EXEC"
    ok "  Icon = ${ICON_FILE:-dsh-desktop-linux}"
  elif [ -f "$REPO_ROOT/package.json" ] && grep -q '"name": "dsh-desktop-linux"' "$REPO_ROOT/package.json" 2>/dev/null; then
    # 源码运行场景：写一个 wrapper 脚本再指向它
    WRAPPER="$HOME/.local/bin/dsh-desktop-linux-launch.sh"
    mkdir -p "$(dirname "$WRAPPER")"
    cat > "$WRAPPER" <<EOF2
#!/usr/bin/env bash
# 由 dsh-desktop-linux/install.sh 生成的启动器
cd "$REPO_ROOT" || exit 1
exec npm start
EOF2
    chmod +x "$WRAPPER"
    cat > "$DESKTOP_FILE" <<EOF2
[Desktop Entry]
Type=Application
Name=DSH Desktop
GenericName=DeepSeek Harness Desktop
Comment=DeepSeek Harness desktop client for Linux
Exec=$WRAPPER
Icon=${ICON_FILE:-dsh-desktop-linux}
Terminal=false
Categories=Development;
StartupWMClass=DSH Desktop
EOF2
    chmod +x "$DESKTOP_FILE"
    ok "桌面图标: $DESKTOP_FILE"
    ok "  Exec = $WRAPPER  (wrapper → cd $REPO_ROOT && npm start)"
    ok "  Icon = ${ICON_FILE:-dsh-desktop-linux}"
  else
    warn "找不到桌面端可执行文件 / 也不是从源码克隆运行，未生成桌面图标"
    warn "  请先装桌面端（下载 AppImage / deb / rpm 或 git clone 仓库），"
    warn "  然后再跑一次 install.sh"
  fi
fi

cat <<'EOF'

✓ 准备完成。

下一步：
  - 双击桌面图标 / 运行已下载的 AppImage/deb/rpm
  - 或者从源码运行：cd 仓库 && npm start
  - 或用 --with-systemd 时：systemctl --user status dsh-web 看后台服务

EOF