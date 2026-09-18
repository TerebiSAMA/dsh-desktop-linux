# DSH Desktop (Linux)

> Desktop shell for DeepSeek Harness on Linux — standalone window · tray · autostart · auto-update

[中文文档](./README.md)

## What is it

`dsh-desktop-linux` is an Electron shell wrapping the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Web GUI (`http://127.0.0.1:3080`). It gives you:

- 🪟 Standalone window + system tray
- 🔔 Task-status signal → tray LED (done / ask / fail)
- 🚀 Autostart on login (XDG autostart)
- 🔐 Self-signed cookie auth — no token to copy
- 🔄 Auto-update via GitHub Releases

## One-line install (recommended)

One command sets up everything: DSH backend + GUI client plugins + optional
systemd watchdog + optional XDG autostart + first-run credentials.

```bash
curl -fsSL https://raw.githubusercontent.com/TerebiSAMA/dsh-desktop-linux/main/install.sh | bash -s -- --with-systemd
```

Flags:

| flag | what it does |
|---|---|
| `--with-systemd` | install + enable systemd user unit (DSH Web watchdog with auto-restart) |
| `--with-autostart` | install XDG autostart entry (boot into the desktop client) |
| `--no-launch` | don't auto-start `dsh web` after install |

After it finishes, launch the desktop client via whichever package you grabbed
(double-click the icon / `./DSH-Desktop-*.AppImage` / `sudo dnf install ./...rpm`
— see the **Install** section below). The script is idempotent — re-running it
won't clobber existing config.

On success the script also drops a `dsh-desktop-linux.desktop` launcher into
`~/Desktop/` (Exec field is auto-detected: `/opt/...`, `/usr/bin/...`,
AppImage, or a wrapper that does `cd <repo> && npm start`). Headless hosts
without `~/Desktop` are skipped without error.

## Startup flow (zero-config)

After a double-click, the desktop client walks through this state machine automatically:

1. Probe `http://127.0.0.1:3080`; if reachable, load the GUI
2. Not reachable → try `systemctl --user start dsh-web` (if you have the template installed)
3. Still down → look up `dsh` in `PATH`
4. No `dsh` → run `npm install -g @deepseek-ai/dsh`; if it fails, retry with `pkexec`
5. Once installed → run `dsh web`, then poll until the port is ready
6. All paths exhausted → error page shows manual install commands and the last error,
   with a one-click "copy" button

**Prerequisites**: `node` + `npm` on PATH. `pkexec` is needed for the privileged install
attempt (ships with most distros).

## Optional: pre-install manually

You usually don't need to — the desktop will install everything itself. But if you want
to manage the backend yourself:

1. Install from npm and run `dsh web`
   ```bash
   npm install -g @deepseek-ai/dsh
   dsh web
   ```
2. Or run from a source-tree build (see upstream `deepseek-ai/deepseek-harness`)
3. Or keep it under a systemd user service (template in `extra/systemd/dsh-web.service`)

**Before first launch** make sure `dsh web` has been started at least once — it writes the
browser-session secret to `~/.dsh/.credentials.yaml`, which the desktop app needs for
self-signed cookie auth.

## Install

> **No prebuilt packages are published from this repo yet** — run from source.
> The CI workflow (`.github/workflows/release.yml`) is in place and will publish
> AppImage / deb / rpm to the Releases page automatically once a release tag is
> pushed.

### Run from source (recommended)

```bash
git clone https://github.com/TerebiSAMA/dsh-desktop-linux.git
cd dsh-desktop-linux
npm install
npm start
```

`npm start` boots Electron in dev mode — renderer changes hot-reload, but
main-process edits require a manual restart.

### Build packages locally (optional)

```bash
npm run pack        # unpacked runnable build (no installer)
npm run dist        # AppImage / deb / rpm under dist/
```

`npm run dist` needs `electron-builder`'s local toolchain (`rpm-build`,
`fakeroot`, etc.). To get prebuilt packages without setting that up locally,
trigger the `.github/workflows/release.yml` workflow in your fork — it drops
artifacts on the Releases page.

## LAN access (exposing dsh to other machines on the network)

DSH binds to `127.0.0.1:3080` by default, and the npm-shipped bundle
hard-blocks `0.0.0.0` even with `DSH_ALLOW_PUBLIC_BIND`. This repo ships a
**zero-dependency Node reverse proxy** (`tools/dsh-lan-proxy.js`) that listens
on `0.0.0.0:<LAN_PORT>` (default `5080`), forwards to `127.0.0.1:3080`, and
**re-issues the browser cookie itself** — because dsh's HMAC cookie is bound
to the request's `Host` header and gets dropped by dsh's host fence if you
just tunnel.

### Install (systemd user units)

```bash
# Install the proxy and token watcher to standard locations
sudo install -m755 tools/dsh-lan-proxy.js /usr/local/lib/dsh-desktop-linux/dsh-lan-proxy.js
sudo install -m755 tools/dsh-lan-proxy-env.sh /usr/local/bin/dsh-lan-proxy-env
sudo mkdir -p /usr/local/lib/dsh-desktop-linux

# Drop the systemd units into your user config
mkdir -p ~/.config/systemd/user
cp extra/systemd/dsh-lan-proxy.service ~/.config/systemd/user/
cp extra/systemd/dsh-lan-proxy-env.service ~/.config/systemd/user/

# Fill the two placeholders: DSH_LAN_HOST, DSH_ALLOWED_REMOTE
$EDITOR ~/.config/systemd/user/dsh-lan-proxy.service
#   Environment=DSH_LAN_HOST=192.168.x.y          ← this host's LAN IP
#   Environment=DSH_ALLOWED_REMOTE=192.168.x.z     ← client IP(s) allowed in (comma-separated)

# Tell dsh to trust the LAN authority (drop-in override)
mkdir -p ~/.config/systemd/user/dsh-web.service.d
cp extra/systemd/dsh-web.service.d/public-bind.conf.example \
   ~/.config/systemd/user/dsh-web.service.d/public-bind.conf
$EDITOR ~/.config/systemd/user/dsh-web.service.d/public-bind.conf
#   Replace <LAN_IP> with this host's LAN IP (must match DSH_LAN_HOST)

systemctl --user daemon-reload
systemctl --user enable --now dsh-lan-proxy-env.service
systemctl --user enable --now dsh-lan-proxy.service
systemctl --user restart dsh-web.service
```

### firewalld (strongly recommended)

Limit the 5080/tcp port to only the LAN clients you trust:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.x.z" port port="5080" protocol="tcp" accept'
sudo firewall-cmd --reload
```

For belt-and-braces default-deny, also add a reject rule for everything else:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" port port="5080" protocol="tcp" reject'
sudo firewall-cmd --reload
```

### How it works (one-paragraph summary)

The proxy listens on `0.0.0.0:5080`. On the first request, it internally
issues a GET to `127.0.0.1:3080/?token=<token>` with `Host: <LAN_IP>:5080`,
lets dsh mint its own HMAC cookie against that authority, and caches it.
Every subsequent request has that cookie + a rewritten `Host` / `Origin` /
`Referer` injected, so dsh sees a single consistent browser session and its
host fence passes. WebSocket upgrades for `/api/remote.mux` are passed through
verbatim with `Upgrade` and `Connection` headers intact. When dsh restarts and
mints a fresh token, `dsh-lan-proxy-env.service` tails the systemd journal,
writes the new `DSH_TOKEN` to `/run/user/<uid>/dsh-lan-proxy.env`, and the
proxy re-primes on the next request — no human intervention needed.

### Configuration

The proxy reads these environment variables (set via `Environment=` in the
systemd unit):

| variable | default | meaning |
|---|---|---|
| `DSH_LAN_HOST` | `127.0.0.1` | LAN-visible IP (set this to your host's LAN IP) |
| `DSH_LAN_PORT` | `5080` | LAN port |
| `DSH_UPSTREAM` | `http://127.0.0.1:3080` | dsh upstream |
| `DSH_TOKEN_FILE` | `/run/user/%U/dsh-lan-proxy.env` | token file (written by watcher) |
| `DSH_COOKIE_TTL_MS` | `600000` | cookie reuse window (10 minutes) |
| `DSH_ALLOWED_REMOTE` | `""` | comma-separated client IP whitelist; empty = allow all |

### Security caveats

- This proxy **does not terminate TLS**. For untrusted networks put a
  TLS terminator in front (caddy / nginx / stunnel), or your cookies and
  chat content go over the wire in plaintext.
- **`DSH_ALLOWED_REMOTE` must be set** — empty means open to every IP.
- The firewalld rule is a second line of defense; use both.
- The proxy does not modify dsh state — it only forwards. To revoke access
  to a LAN client, just remove their IP from `DSH_ALLOWED_REMOTE` and
  reload the proxy.

## Auto-update

The desktop checks GitHub Releases periodically and shows a tray notification when
a new version is available; the upgrade is applied on the next launch
(`electron-updater`).

To disable auto-update there is no UI switch in this version — disconnect from the
network before quitting if you want to keep the current build. A UI toggle is
planned.

## Development

```bash
git clone https://github.com/TerebiSAMA/dsh-desktop-linux.git
cd dsh-desktop-linux
npm install
npm start
```

Build local artefacts:

```bash
npm run pack        # unpacked dev build
npm run dist        # AppImage + deb + rpm into dist/
```

## Project layout

```
src/
  main.js          # main process: window, tray, autostart, self-signed cookie
  preload.js       # context-isolated IPC bridge
  error.html       # fallback when the Web service is unreachable
assets/
  *.png            # app icon + tray state frames
tools/
  gen-tray-assets.py  # tray frame generator (skin x state x DPI)
plugins/           # DSH GUI client plugin backups (not desktop code)
install.sh         # one-line installer (backend + plugins + systemd + autostart)
.github/workflows/
  release.yml      # build AppImage / deb / rpm
extra/
  systemd/         # systemd user unit template (optional)
  autostart/       # XDG autostart template (optional)
```

## FAQ

### Double-click shows "systemctl --user status dsh-web"

Means the DSH Web service is not running. Check:

```bash
systemctl --user status dsh-web   # if you set up the unit
curl http://127.0.0.1:3080/        # direct probe
```

If the service isn't running but you installed `@deepseek-ai/dsh` via npm,
just run `dsh web` directly. The desktop app will also try to bring it up
automatically (systemd unit first, then `dsh web` via PATH as a fallback).

### Self-signed cookie doesn't work

Run `dsh web` at least once manually before opening the desktop, so the
browser-session secret lands in `~/.dsh/.credentials.yaml`. If the secret is
lost, delete the file and restart `dsh web`.

### Service start steals focus from my minimized browser

If you start the service directly with `dsh web`, it auto-opens the default
browser. Pass `--no-open` (or use the unit template under `extra/systemd/`)
to keep the desktop app as the only UI.

## License

MIT — see [LICENSE](./LICENSE).

## Links

- Upstream DSH: <https://github.com/deepseek-ai/deepseek-harness>
- This repo: <https://github.com/TerebiSAMA/dsh-desktop-linux>