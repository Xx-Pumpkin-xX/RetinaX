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
#   AI_URL=http://localhost:8000                 the model, privately
#   PUBLIC_URL=https://<the tunnel hostname>      for the status check only
#
# Everything in host.env reaches node, because node reads the file itself.
# Adding a variable there is all it takes - nothing has to be named twice.
#
# Reaching the model privately is the point: /infer has no authentication of
# its own, so it should not be on the open internet. Two ways, either is fine:
#
#   Tailscale     both machines on the tailnet, AI_URL=http://<spark-name>:8000
#   SSH tunnel    set AI_SSH below; needs nothing installed on the GPU host,
#                 which matters when you do not have root on it
#
#   AI_SSH=hungntt@spark.example.com    (optional) open ssh -N -L to the model
#   AI_SSH_PORT=8000                    remote port, default 8000
set -euo pipefail

SESSION=retinax-api
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=${PORT:-3000}
LOG="$HERE/api.log"
TLOG="$HERE/tunnel.log"

# shellcheck disable=SC1091
[ -f "$HERE/host.env" ] && set -a && . "$HERE/host.env" && set +a

# The public address of the API, for the status check only - nothing here
# starts the tunnel. cloudflared is run by hand in its own tmux session and
# hands out a new hostname each time, so PUBLIC_URL is written into host.env
# after starting it. NGROK_DOMAIN is the older reserved-domain form.
public_url() {
  if   [ -n "${PUBLIC_URL:-}" ];   then echo "${PUBLIC_URL%/}"
  elif [ -n "${NGROK_DOMAIN:-}" ]; then echo "https://$NGROK_DOMAIN"
  else return 1
  fi
}

case "${1:-start}" in
  url) public_url || { echo "PUBLIC_URL is not set in host.env"; exit 1; } ;;

  logs) tail -n 60 -f "$LOG" ;;

  stop) tmux kill-session -t "$SESSION" 2>/dev/null && echo "stopped." || echo "was not running." ;;

  status)
    echo "tmux:  $(tmux has-session -t "$SESSION" 2>/dev/null && echo running || echo 'NOT running')"
    echo -n "api:   "; curl -s -m 5 "http://localhost:$PORT/api/cases" || echo "(no answer on :$PORT)"; echo
    [ -n "${AI_SSH:-}" ] && echo "tunnel: ssh -L to $AI_SSH"
    echo -n "model: "; curl -s -m 8 "${AI_URL:-http://localhost:8000}/health" \
      || echo "(unreachable — check the tunnel, or Tailscale on both ends)"; echo
    U="$(public_url || true)"
    [ -n "$U" ] && { echo -n "public: "; curl -s -m 15 "$U/api/health" || echo "(no answer)"; echo; }
    ;;

  start)
    tmux has-session -t "$SESSION" 2>/dev/null && { echo "Already running."; bash "$0" status; exit 0; }

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

    : > "$TLOG"

    # An SSH tunnel to the GPU host, when that machine cannot join the tailnet
    # — no root needed there, and the model stays off the public internet.
    # autossh reconnects after a dropped link; plain ssh does not, so the
    # ServerAlive options at least make a dead one fail fast rather than hang.
    if [ -n "${AI_SSH:-}" ]; then
      SSH_BIN=ssh; command -v autossh >/dev/null 2>&1 && SSH_BIN=autossh
      RP="${AI_SSH_PORT:-8000}"
      tmux new-session -d -s "$SESSION" -c "$HERE" \
        "$SSH_BIN -N -L $RP:localhost:$RP \
           -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
           -o ExitOnForwardFailure=yes $AI_SSH 2>&1 | tee '$HERE/ssh-tunnel.log'"
      echo -n "opening the ssh tunnel to $AI_SSH"
      for _ in $(seq 1 10); do
        sleep 1
        curl -s -m 2 "http://localhost:$RP/api/health" >/dev/null 2>&1 && break
        printf .
      done
      echo
      HAVE_SESSION=1
    else
      HAVE_SESSION=0
    fi

    # Warn, do not block: the API is useful with the model down — that is the
    # whole reason for splitting them.
    curl -s -m 8 "$AI_URL/health" >/dev/null 2>&1 \
      || echo "note: $AI_URL is not answering. The API will still serve every existing case; only new uploads will fail."

    # node reads host.env itself rather than being handed the values on its
    # command line. Two reasons, both learned the hard way:
    #
    #   nothing to keep in step  the old form named each variable explicitly,
    #                            so anything added to host.env and forgotten
    #                            here was set and silently ignored
    #   nothing in `ps`          a command line is world-readable on this
    #                            machine, and JWT_SECRET was in it
    #
    # PORT and NODE_ENV stay on the line because they are not secrets and do
    # not live in host.env. A value on the line WINS over the same name in the
    # file, which is why SEED_DEMO is written as a default here rather than a
    # constant - host.env has already been sourced, so its value is what lands.
    ENV_FILE=""
    [ -f "$HERE/host.env" ] && ENV_FILE="--env-file='$HERE/host.env'"

    API_CMD="NODE_ENV=production PORT=$PORT SEED_DEMO='${SEED_DEMO:-1}' \
       node $ENV_FILE server.js 2>&1 | tee '$LOG'"
    if [ "$HAVE_SESSION" = "1" ]; then
      tmux split-window -t "$SESSION" -c "$HERE" "$API_CMD"
    else
      tmux new-session -d -s "$SESSION" -c "$HERE" "$API_CMD"
    fi

    if [ -n "${NGROK_DOMAIN:-}" ]; then
      tmux split-window -t "$SESSION" -c "$HERE" \
        "ngrok http --domain=$NGROK_DOMAIN $PORT --log stdout 2>&1 | tee '$TLOG'"
      tmux select-layout -t "$SESSION" even-vertical >/dev/null 2>&1 || true
    fi

    echo -n "starting"
    for _ in $(seq 1 20); do
      sleep 2
      if curl -s -m 3 "http://localhost:$PORT/api/cases" | grep -q "Not signed in"; then
        echo; echo "READY."; bash "$0" status; exit 0
      fi
      printf .
    done
    echo; echo "not up yet — check: ./run-on-host.sh logs" >&2; exit 1
    ;;

  *) echo "usage: $0 [start|status|url|logs|stop]" >&2; exit 1 ;;
esac
