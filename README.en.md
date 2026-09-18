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

Grab the latest release from
[Releases](https://github.com/TerebiSAMA/dsh-desktop-linux/releases)
(`DSH-Desktop-*.AppImage` / `.deb` / `.rpm`).

### AppImage (most portable)

```bash
chmod +x DSH-Desktop-*.AppImage
./DSH-Desktop-*.AppImage
```

To register as a desktop icon, move the AppImage to `~/Applications/` and run
`appimaged` once.

### Debian / Ubuntu

```bash
sudo dpkg -i dsh-desktop-linux_*.deb
sudo apt -f install   # pull missing deps, if any
```

### Fedora / RHEL

```bash
sudo dnf install ./dsh-desktop-linux-*.rpm
```

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