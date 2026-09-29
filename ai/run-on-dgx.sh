#!/usr/bin/env bash
#
# Start the grading service and its public tunnel on the DGX Spark, inside tmux
# so both survive your SSH session ending — and survive you closing JupyterLab.
#
#   ./run-on-dgx.sh          start both
#   ./run-on-dgx.sh status   is it up, and is the real model loaded? (--raw for JSON)
#   ./run-on-dgx.sh url      print the public URL
#   ./run-on-dgx.sh logs     tail the service log
#   ./run-on-dgx.sh stop     stop both
#
# Configure once by writing ai/dgx.env next to this script:
#
#   DR_REPO=/home/hungntt/Projects/USTH/ProjectDR2026
#   MODEL_PATH=$DR_REPO/src/experiments/Stage2_Finetune_B7_CBAM/stage2_best_model.pth
#   THRESHOLD_PATH=$DR_REPO/src/experiments/Stage2_Finetune_B7_CBAM/best_thresholds.npy
#   NGROK_DOMAIN=acuteness-finless-pluck.ngrok-free.dev
#
# To also run the Express API here — which is what makes the data permanent,
# because this machine has a real disk and does not sleep — add:
#
#   SERVE_API=1
#   API_PORT=3000
#   VAR_DIR=$HOME/retinax-data
#   WEB_ORIGIN=https://retinax.pages.dev
#   JWT_SECRET=<paste: openssl rand -hex 32>
#
# With SERVE_API=1 the tunnel points at the API, not at the model: the API
# reaches the model over localhost, so one tunnel serves the whole backend.
#
# With NGROK_DOMAIN set the public hostname never changes, so AI_URL on Render
# is set once and survives every restart of this machine. Without it the script
# falls back to a Cloudflare quick tunnel, whose URL changes every time.
set -euo pipefail

SESSION=retinax-ai
PORT=${PORT:-8000}          # the model service
API_PORT=${API_PORT:-3000}  # the Express API, when SERVE_API=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HERE/tunnel.log"
SVC_LOG="$HERE/service.log"

# shellcheck disable=SC1091
[ -f "$HERE/dgx.env" ] && set -a && . "$HERE/dgx.env" && set +a

# The tunnel fronts whichever process the outside world needs to reach.
tunnel_port() { [ "${SERVE_API:-0}" = "1" ] && echo "$API_PORT" || echo "$PORT"; }

tunnel_cmd() {
  if [ -n "${NGROK_DOMAIN:-}" ] && command -v ngrok >/dev/null 2>&1; then
    # A reserved domain on the free plan: one static hostname, one agent.
    echo "ngrok http --domain=$NGROK_DOMAIN $(tunnel_port) --log stdout"
    return
  fi

  local cf="$HERE/cloudflared"
  if command -v cloudflared >/dev/null 2>&1; then cf=cloudflared; fi
  if [ ! -x "$cf" ] && [ "$cf" != cloudflared ]; then
    # The Spark is arm64 — the amd64 build silently does not run.
    local arch; arch="$(uname -m)"
    case "$arch" in
      aarch64|arm64) arch=arm64 ;;
      x86_64)        arch=amd64 ;;
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
    esac
    echo "downloading cloudflared ($arch)…" >&2
    curl -fsSL -o "$HERE/cloudflared" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
    chmod +x "$HERE/cloudflared"
  fi
  # --protocol http2 forces TCP. The default is QUIC over UDP 7844, which this
  # network blocks: the tunnel appears to start and then never serves anything.
  echo "$cf tunnel --protocol http2 --url http://localhost:$(tunnel_port)"
}

public_url() {
  if [ -n "${NGROK_DOMAIN:-}" ]; then echo "https://$NGROK_DOMAIN"; return; fi
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | tail -1
}

# /health rendered short. Raw JSON instead:  ./run-on-dgx.sh status --raw
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
print("gate    %s | accept>=%.2f reject<=%.2f" % (
    h.get("fundus_gate_model", "?"),
    h.get("fundus_accept_threshold", 0), h.get("fundus_reject_threshold", 0)))
bad = []
if not h.get("model_loaded"):       bad.append("MODEL NOT LOADED")
if not h.get("fundus_gate_loaded"): bad.append("FUNDUS GATE NOT LOADED")
if h.get("on_cpu_fallback"):        bad.append("RUNNING ON CPU, not cuda")
if len(loaded) < 6:                 bad.append("only %d of 6 lesion models" % len(loaded))
if h.get("note"):                   bad.append(str(h["note"]))
if bad:
    print("warn    " + " | ".join(bad))
'

# $1 = base url. Prints the summary, or the raw body if python cannot read it.
health() {
  local j
  j="$(curl -s -m 15 "$1/health" 2>/dev/null || true)"
  if [ -z "$j" ]; then echo "model   no answer at $1"; return 1; fi
  if [ "${RAW:-0}" = "1" ] || ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "$j"; return 0
  fi
  printf '%s' "$j" | python3 -c "$HEALTH_FMT" || printf '%s\n' "$j"
}

case "${1:-start}" in
  url)
    public_url || { echo "no URL yet — check $LOG"; exit 1; }
    ;;

  status)
    if [ "${2:-}" = "--raw" ] || [ "${2:-}" = "raw" ]; then RAW=1; fi
    echo "tmux    $(tmux has-session -t "$SESSION" 2>/dev/null && echo running || echo 'NOT running')"
    health "http://localhost:$PORT" || true
    if [ "${SERVE_API:-0}" = "1" ]; then
      echo -n "api     "; curl -s -m 5 "http://localhost:$API_PORT/api/cases" || echo "(no answer on :$API_PORT)"
      echo
    fi
    if [ "${TUNNEL:-1}" = "0" ]; then
      echo "tunnel  off - reached privately over Tailscale"
      command -v tailscale >/dev/null 2>&1 && echo "        this host: $(tailscale status --self --peers=false 2>/dev/null | head -1)"
    fi
    U="$([ "${TUNNEL:-1}" = "1" ] && public_url || true)"
    if [ -n "$U" ]; then echo "tunnel  $U"; health "$U" || true; fi
    ;;

  logs)
    tail -n 60 -f "$SVC_LOG"
    ;;

  stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "stopped." || echo "was not running."
    ;;

  start)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Already running."; "$0" status; exit 0
    fi

    # Loud, early failure beats a service that starts and grades with the
    # fallback thresholds because a path was wrong.
    for v in DR_REPO MODEL_PATH THRESHOLD_PATH; do
      if [ -z "${!v:-}" ]; then
        echo "!! $v is not set. Write ai/dgx.env — see the header of this script." >&2
        exit 1
      fi
    done
    [ -f "$MODEL_PATH" ]     || { echo "!! MODEL_PATH does not exist: $MODEL_PATH" >&2; exit 1; }
    [ -f "$THRESHOLD_PATH" ] || { echo "!! THRESHOLD_PATH does not exist: $THRESHOLD_PATH" >&2; exit 1; }

    if [ "${SERVE_API:-0}" = "1" ]; then
      # Resolved INSIDE the guard. A model-only host has no sibling server/
      # directory, so doing this unconditionally kills the service on exactly
      # the machine that only ever needed to serve the model.
      SRV="$(cd "$HERE/../server" 2>/dev/null && pwd)" \
        || { echo "!! SERVE_API=1 but ../server is not next to this script" >&2; exit 1; }
      for v in VAR_DIR WEB_ORIGIN JWT_SECRET; do
        [ -n "${!v:-}" ] || { echo "!! SERVE_API=1 but $v is not set in dgx.env" >&2; exit 1; }
      done
      # node:sqlite arrived in Node 22.5. Below that the driver falls back to
      # better-sqlite3, which has to compile a native addon on arm64 — a long
      # detour you do not want to discover at start-up.
      NODE_MM="$(node -e 'const [a,b]=process.versions.node.split(".");console.log(a*100+ +b)' 2>/dev/null || echo 0)"
      [ "$NODE_MM" -ge 2205 ] || { echo "!! Node $(node -v 2>/dev/null || echo missing) is too old — need >= 22.5" >&2; exit 1; }
      [ -d "$SRV/node_modules" ] || { echo "installing API dependencies…"; (cd "$SRV" && npm ci); }
      mkdir -p "$VAR_DIR"
    fi

    : > "$LOG"
    tmux new-session -d -s "$SESSION" -c "$HERE" \
      "uvicorn main:app --host 0.0.0.0 --port $PORT 2>&1 | tee '$SVC_LOG'"

    if [ "${SERVE_API:-0}" = "1" ]; then
      tmux split-window -t "$SESSION" -c "$SRV" \
        "NODE_ENV=production PORT=$API_PORT VAR_DIR='$VAR_DIR' WEB_ORIGIN='$WEB_ORIGIN' \
         JWT_SECRET='$JWT_SECRET' AI_URL=http://localhost:$PORT SEED_DEMO=1 \
         node server.js 2>&1 | tee '$HERE/api.log'"
    fi

    # TUNNEL=0 when the API reaches this service over Tailscale instead. That
    # is the better arrangement: /infer has no authentication of its own, so it
    # has no business being on the open internet.
    if [ "${TUNNEL:-1}" = "1" ]; then
      tmux split-window -t "$SESSION" -c "$HERE" "$(tunnel_cmd) 2>&1 | tee '$LOG'"
    fi
    tmux select-layout -t "$SESSION" even-vertical >/dev/null 2>&1 || true

    echo "starting… (B7 takes ~30-60s to load)"
    for _ in $(seq 1 40); do
      sleep 3
      if curl -s -m 3 "http://localhost:$PORT/health" | grep -q '"model_loaded": *true'; then
        if [ "${SERVE_API:-0}" = "1" ]; then
          curl -s -m 3 "http://localhost:$API_PORT/api/cases" | grep -q "Not signed in" || { printf .; continue; }
        fi
        U="$(public_url || true)"
        echo
        if [ -n "$U" ]; then echo "READY at $U"; else echo "READY - no tunnel, reached privately over Tailscale"; fi
        health "http://localhost:$PORT" || true
        exit 0
      fi
      printf .
    done
    echo; echo "still not ready — check: ./run-on-dgx.sh logs" >&2
    exit 1
    ;;

  *) echo "usage: $0 [start|status [--raw]|url|logs|stop]" >&2; exit 1 ;;
esac
