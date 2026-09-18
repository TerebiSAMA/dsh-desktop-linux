#!/usr/bin/env bash
# Watch dsh-web.service journal, capture its launch URL, expose DSH_TOKEN
# via an env file so dsh-lan-proxy.service can read it on every restart.

set -euo pipefail

ENV_FILE="/run/user/$(id -u)/dsh-lan-proxy.env"
mkdir -p "$(dirname "$ENV_FILE")"

journalctl --user -u dsh-web.service -f -o cat --no-tail -n 0 \
  | grep --line-buffered 'dsh web: http' \
  | while IFS= read -r line; do
      # "dsh web: http://127.0.0.1:3080/?token=XXXX"
      tok=$(printf '%s\n' "$line" | sed -n 's/.*token=\([^ ]*\).*/\1/p')
      if [ -n "$tok" ]; then
        printf 'DSH_TOKEN=%s\n' "$tok" > "$ENV_FILE"
        echo "$(date -Iseconds) updated DSH_TOKEN (${#tok} chars)"
      fi
    done
