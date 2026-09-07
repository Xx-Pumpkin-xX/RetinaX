#!/usr/bin/env bash
#
# Start the grading service and its public tunnel on the DGX Spark, inside tmux
# so both survive your SSH session ending.
#
#   ./run-on-dgx.sh          start (or reattach to) both
#   ./run-on-dgx.sh url      print the current public URL
#   ./run-on-dgx.sh stop     stop both
#
# The URL it prints is what goes in AI_URL on Render. Quick tunnels get a new
# URL every restart, so re-run `./run-on-dgx.sh url` after any restart and
# update the variable.
set -euo pipefail

SESSION=retinax-ai
PORT=${PORT:-8000}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HERE/tunnel.log"

need_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then echo cloudflared; return; fi
  if [ -x "$HERE/cloudflared" ]; then echo "$HERE/cloudflared"; return; fi

  # The DGX Spark is arm64, so take the arm64 build, not amd64.
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
  echo "$HERE/cloudflared"
}

case "${1:-start}" in
  url)
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | tail -1 \
      || { echo "no URL yet — check $LOG"; exit 1; }
    ;;

  stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "stopped." || echo "was not running."
    ;;

  start)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Already running. URL:"; "$0" url; exit 0
    fi

    CF="$(need_cloudflared)"
    : > "$LOG"

    tmux new-session -d -s "$SESSION" -c "$HERE" \
      "uvicorn main:app --host 0.0.0.0 --port $PORT 2>&1 | tee '$HERE/service.log'"
    tmux split-window -t "$SESSION" -c "$HERE" \
      "'$CF' tunnel --url http://localhost:$PORT 2>&1 | tee '$LOG'"

    echo -n "waiting for the model to load"
    for _ in $(seq 1 60); do
      if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
      echo -n "."; sleep 2
    done
    echo
    curl -fsS "http://localhost:$PORT/health" \
      || { echo "service did not come up — tmux attach -t $SESSION"; exit 1; }
    echo

    echo -n "waiting for the tunnel"
    for _ in $(seq 1 30); do
      if grep -q 'trycloudflare.com' "$LOG" 2>/dev/null; then break; fi
      echo -n "."; sleep 2
    done
    echo

    URL="$("$0" url)"
    echo
    echo "  Public URL : $URL"
    echo "  Health     : $URL/health"
    echo
    echo "Set AI_URL to that on Render (no trailing slash)."
    echo "Attach with: tmux attach -t $SESSION    (detach: Ctrl-B then D)"
    ;;

  *) echo "usage: $0 [start|url|stop]" >&2; exit 1 ;;
esac
