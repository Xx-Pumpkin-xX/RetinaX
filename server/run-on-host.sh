#!/usr/bin/env bash
#
# Run the RetinaX API on the storage host — the always-on machine that holds
# the database and every uploaded photograph.
#
#   ./run-on-host.sh          start the API and its public tunnel
#   ./run-on-host.sh status   is it up, and can it see the model? (--raw for JSON)
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

# /health and /api/health rendered short.  Raw JSON:  ./run-on-host.sh status --raw
HEALTH_FMT='
import json, sys
try:
    h = json.load(sys.stdin)
except Exception:
    sys.exit(1)
on = lambda b: "on" if b else "off"
loaded = h.get("lesions_loaded") or []
est = h.get("lesions_established") or []
prov = [x for x in loaded if x not in est]
th = h.get("thresholds") or []
print("model   %s | %spx | cbam %s | tta %s | %s" % (
    h.get("model_name", "?"), h.get("image_size", "?"),
    on(h.get("use_cbam")), on(h.get("tta")), h.get("device", "?")))
print("lesion  established: %s | provisional: %s" % (
    " ".join(est) or "-", " ".join(prov) or "-"))
print("grade   %s | cuts %s" % (
    h.get("thresholds_source", "?"),
    " ".join("%.3f" % t for t in th) or "-"))
bad = []
if not h.get("model_loaded"):       bad.append("MODEL NOT LOADED")
if not h.get("fundus_gate_loaded"): bad.append("FUNDUS GATE NOT LOADED")
if h.get("on_cpu_fallback"):        bad.append("RUNNING ON CPU, not cuda")
if len(loaded) < 6:                 bad.append("only %d of 6 lesion models" % len(loaded))
if h.get("note"):                   bad.append(str(h["note"]))
if bad:
    print("warn    " + " | ".join(bad))
'

API_FMT='
import json, sys
try:
    h = json.load(sys.stdin)
except Exception:
    sys.exit(1)
up = int(h.get("uptimeSeconds") or 0)
if up >= 3600:  age = "%dh%02dm" % (up // 3600, (up % 3600) // 60)
elif up >= 60:  age = "%dm" % (up // 60)
else:           age = "%ds" % up
print("build   %s (%s, %s) | packed by %s | node %s | up %s" % (
    h.get("version", "?"), h.get("commit", "?"), h.get("branch", "?"),
    h.get("packedBy", "?"), h.get("node", "?"), age))
say = lambda b: "ok" if b else "DOWN"
print("api     db %s | model %s | assistant %s | mail %s" % (
    say(h.get("database")), say(h.get("model")),
    "on" if h.get("assistant") else "off",
    "ok" if h.get("mail") else "not configured"))
'

# $1 = base url of the model service
health() {
  local j
  j="$(curl -s -m 15 "$1/health" 2>/dev/null || true)"
  if [ -z "$j" ]; then echo "model   unreachable at $1 - check the tunnel, or Tailscale on both ends"; return 1; fi
  if [ "${RAW:-0}" = "1" ] || ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "$j"; return 0
  fi
  printf '%s' "$j" | python3 -c "$HEALTH_FMT" || printf '%s\n' "$j"
}

# $1 = base url of the API
api_health() {
  local j
  j="$(curl -s -m 15 "$1/api/health" 2>/dev/null || true)"
  if [ -z "$j" ]; then echo "api     no answer at $1"; return 1; fi
  if [ "${RAW:-0}" = "1" ] || ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "$j"; return 0
  fi
  printf '%s' "$j" | python3 -c "$API_FMT" || printf '%s\n' "$j"
}

case "${1:-start}" in
  url) public_url || { echo "PUBLIC_URL is not set in host.env"; exit 1; } ;;

  logs) tail -n 60 -f "$LOG" ;;

  stop) tmux kill-session -t "$SESSION" 2>/dev/null && echo "stopped." || echo "was not running." ;;

  status)
    if [ "${2:-}" = "--raw" ] || [ "${2:-}" = "raw" ]; then RAW=1; fi
    echo "tmux    $(tmux has-session -t "$SESSION" 2>/dev/null && echo running || echo 'NOT running')"
    api_health "http://localhost:$PORT" || true
    [ -n "${AI_SSH:-}" ] && echo "tunnel  ssh -L to $AI_SSH"
    health "${AI_URL:-http://localhost:8000}" || true
    U="$(public_url || true)"
    if [ -n "$U" ]; then
      P="$(curl -s -m 15 "$U/api/health" 2>/dev/null || true)"
      # A grep, not a JSON parse: this line only needs to know whether the API
      # itself answered through the tunnel, and anything that is not the API -
      # a Cloudflare error page, an interstitial - simply will not match.
      if [ -z "$P" ]; then
        echo "public  $U  NO ANSWER - the tunnel is not serving"
      elif printf '%s' "$P" | grep -q '"ok":[[:space:]]*true'; then
        echo "public  $U  ok"
      else
        echo "public  $U  answered, but not with the API health - first 120 bytes:"
        printf '        %.120s\n' "$P"
      fi
    fi
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

    # The vault has to be open before anything touches VAR_DIR. When it is not,
    # VAR_DIR is an ordinary empty directory: the API starts on a brand-new
    # empty database and writes plaintext photographs into the mountpoint,
    # where they are hidden the moment the vault is mounted over them. Nothing
    # in the output says so - /api/health cheerfully reports database ok. This
    # happened on 29 Sep 2026 and cost an afternoon of forensics.
    #
    # Two independent tests, because either one can be unavailable: a marker
    # file that exists only inside the vault, and the kernel's mount table.
    VAULT_DIR="${VAULT_DIR:-$HOME/retinax-vault}"
    if [ -d "$VAULT_DIR" ] && [ ! -f "$VAR_DIR/.vault-open" ] \
       && ! { command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$VAR_DIR"; }; then
      echo "!! the vault is not open — refusing to start on $VAR_DIR" >&2
      echo "     gocryptfs '$VAULT_DIR' '$VAR_DIR'" >&2
      echo "   then start again. If gocryptfs says 'not empty', STOP: something" >&2
      echo "   is already in the mountpoint and it is not your data." >&2
      echo "   (VAULT_DIR= disables this check, for a deployment with no vault)" >&2
      exit 1
    fi

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

    # Wrapped in a loop, not run once. node can still be killed by something no
    # handler catches - the process exiting is exactly what happened on 29 Sep
    # 2026, and because the tmux session died with it the API stayed down until
    # a person happened to look. Two seconds of downtime is a clinician pressing
    # the button again; an unattended outage is the whole clinic.
    #
    # Every restart writes a line, so a service that is quietly dying and coming
    # back reads as a crash loop in the log instead of hiding as good uptime.
    API_CMD="while true; do \
       NODE_ENV=production PORT=$PORT SEED_DEMO='${SEED_DEMO:-1}' \
         node $ENV_FILE server.js 2>&1; \
       echo \"[respawn] node exited (\$?) at \$(date -Is) - restarting in 2s\"; \
       sleep 2; \
     done | tee '$LOG'"
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

  *) echo "usage: $0 [start|status [--raw]|url|logs|stop]" >&2; exit 1 ;;
esac
