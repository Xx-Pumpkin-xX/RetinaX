#!/usr/bin/env bash
#
# Run the RetinaX API on the storage host — the always-on machine that holds
# the database and every uploaded photograph.
#
#   ./run-on-host.sh          start the API and its public tunnel
#   ./run-on-host.sh status   is it up, and can it see the model?
#   ./run-on-host.sh logs     tail the API log
#   ./run-on-host.sh stop     stop both
#
# Configure once by writing server/host.env next to this script:
#
#   VAR_DIR=/srv/retinax-data                    the database and the images
#   WEB_ORIGIN=https://retinax.pages.dev         exact, no trailing slash
#   JWT_SECRET=<openssl rand -hex 32>
#   AI_URL=http://<spark-tailscale-name>:8000    private, over the tailnet
#   NGROK_DOMAIN=acuteness-finless-pluck.ngrok-free.dev
#
# AI_URL over Tailscale rather than a public tunnel is the point: the model
# service has no authentication of its own, so it should not be on the open
# internet. On the tailnet only your machines can reach it, the address never
# changes, and there is no tunnel to die.
set -euo pipefail

SESSION=retinax-api
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=${PORT:-3000}
LOG="$HERE/api.log"
TLOG="$HERE/tunnel.log"

# shellcheck disable=SC1091
[ -f "$HERE/host.env" ] && set -a && . "$HERE/host.env" && set +a

public_url() { [ -n "${NGROK_DOMAIN:-}" ] && echo "https://$NGROK_DOMAIN"; }

case "${1:-start}" in
  url) public_url || { echo "NGROK_DOMAIN is not set"; exit 1; } ;;

  logs) tail -n 60 -f "$LOG" ;;

  stop) tmux kill-session -t "$SESSION" 2>/dev/null && echo "stopped." || echo "was not running." ;;

  status)
    echo "tmux:  $(tmux has-session -t "$SESSION" 2>/dev/null && echo running || echo 'NOT running')"
    echo -n "api:   "; curl -s -m 5 "http://localhost:$PORT/api/cases" || echo "(no answer on :$PORT)"; echo
    echo -n "model: "; curl -s -m 8 "${AI_URL:-http://localhost:8000}/health" || echo "(unreachable — is Tailscale up on both ends?)"; echo
    U="$(public_url || true)"
    [ -n "$U" ] && { echo -n "public: "; curl -s -m 15 -H 'ngrok-skip-browser-warning: 1' "$U/api/cases" || echo "(no answer)"; echo; }
    ;;

  start)
    tmux has-session -t "$SESSION" 2>/dev/null && { echo "Already running."; "$0" status; exit 0; }

    for v in VAR_DIR WEB_ORIGIN JWT_SECRET AI_URL; do
      [ -n "${!v:-}" ] || { echo "!! $v is not set — write server/host.env, see the header." >&2; exit 1; }
    done
    [ "$JWT_SECRET" != "CHANGE_ME" ] || { echo "!! JWT_SECRET is still the placeholder." >&2; exit 1; }

    # node:sqlite landed in Node 22.5. Below it the driver falls back to
    # better-sqlite3, which compiles a native addon — a detour you do not want
    # to find out about here.
    NODE_MM="$(node -e 'const [a,b]=process.versions.node.split(".");console.log(a*100+ +b)' 2>/dev/null || echo 0)"
    [ "$NODE_MM" -ge 2205 ] || { echo "!! Node $(node -v 2>/dev/null || echo 'is missing') — need >= 22.5" >&2; exit 1; }

    [ -d "$HERE/node_modules" ] || { echo "installing dependencies…"; (cd "$HERE" && npm ci); }
    mkdir -p "$VAR_DIR"

    # Warn, do not block: the API is useful with the model down — that is the
    # whole reason for splitting them.
    curl -s -m 8 "$AI_URL/health" >/dev/null 2>&1 \
      || echo "note: $AI_URL is not answering. The API will still serve every existing case; only new uploads will fail."

    : > "$TLOG"
    tmux new-session -d -s "$SESSION" -c "$HERE" \
      "NODE_ENV=production PORT=$PORT VAR_DIR='$VAR_DIR' WEB_ORIGIN='$WEB_ORIGIN' \
       JWT_SECRET='$JWT_SECRET' AI_URL='$AI_URL' SEED_DEMO=1 \
       node server.js 2>&1 | tee '$LOG'"

    if [ -n "${NGROK_DOMAIN:-}" ]; then
      tmux split-window -t "$SESSION" -c "$HERE" \
        "ngrok http --domain=$NGROK_DOMAIN $PORT --log stdout 2>&1 | tee '$TLOG'"
      tmux select-layout -t "$SESSION" even-vertical >/dev/null 2>&1 || true
    fi

    echo -n "starting"
    for _ in $(seq 1 20); do
      sleep 2
      if curl -s -m 3 "http://localhost:$PORT/api/cases" | grep -q "Not signed in"; then
        echo; echo "READY."; "$0" status; exit 0
      fi
      printf .
    done
    echo; echo "not up yet — check: ./run-on-host.sh logs" >&2; exit 1
    ;;

  *) echo "usage: $0 [start|status|url|logs|stop]" >&2; exit 1 ;;
esac
