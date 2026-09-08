#!/usr/bin/env bash
#
# Start the grading service and its public tunnel on the DGX Spark, inside tmux
# so both survive your SSH session ending — and survive you closing JupyterLab.
#
#   ./run-on-dgx.sh          start both
#   ./run-on-dgx.sh status   is it up, and is the real model loaded?
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
# With NGROK_DOMAIN set the public hostname never changes, so AI_URL on Render
# is set once and survives every restart of this machine. Without it the script
# falls back to a Cloudflare quick tunnel, whose URL changes every time.
set -euo pipefail

SESSION=retinax-ai
PORT=${PORT:-8000}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HERE/tunnel.log"
SVC_LOG="$HERE/service.log"

# shellcheck disable=SC1091
[ -f "$HERE/dgx.env" ] && set -a && . "$HERE/dgx.env" && set +a

tunnel_cmd() {
  if [ -n "${NGROK_DOMAIN:-}" ] && command -v ngrok >/dev/null 2>&1; then
    # A reserved domain on the free plan: one static hostname, one agent.
    echo "ngrok http --domain=$NGROK_DOMAIN $PORT --log stdout"
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
  echo "$cf tunnel --protocol http2 --url http://localhost:$PORT"
}

public_url() {
  if [ -n "${NGROK_DOMAIN:-}" ]; then echo "https://$NGROK_DOMAIN"; return; fi
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | tail -1
}

case "${1:-start}" in
  url)
    public_url || { echo "no URL yet — check $LOG"; exit 1; }
    ;;

  status)
    echo "tmux:  $(tmux has-session -t "$SESSION" 2>/dev/null && echo running || echo 'NOT running')"
    echo -n "local: "; curl -s -m 5 "http://localhost:$PORT/health" || echo "(no answer on :$PORT)"
    echo
    U="$(public_url || true)"
    if [ -n "$U" ]; then echo -n "public ($U): "; curl -s -m 15 "$U/health" || echo "(no answer)"; echo; fi
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

    : > "$LOG"
    tmux new-session -d -s "$SESSION" -c "$HERE" \
      "uvicorn main:app --host 0.0.0.0 --port $PORT 2>&1 | tee '$SVC_LOG'"
    tmux split-window -t "$SESSION" -c "$HERE" "$(tunnel_cmd) 2>&1 | tee '$LOG'"

    echo "starting… (B7 takes ~30-60s to load)"
    for _ in $(seq 1 40); do
      sleep 3
      if curl -s -m 3 "http://localhost:$PORT/health" | grep -q '"model_loaded": *true'; then
        echo; echo "READY.  public URL: $(public_url)"
        curl -s "http://localhost:$PORT/health"; echo
        exit 0
      fi
      printf .
    done
    echo; echo "still not ready — check: ./run-on-dgx.sh logs" >&2
    exit 1
    ;;

  *) echo "usage: $0 [start|status|url|logs|stop]" >&2; exit 1 ;;
esac
