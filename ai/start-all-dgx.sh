#!/usr/bin/env bash
#
# Bring the Spark all the way up: the tailnet first, then ollama, then the
# grading model. Run it from the JupyterLab terminal - this machine has no SSH.
#
#   bash retinax-ai/start-all-dgx.sh
#
# The order is not arbitrary. Without tailscaled, prts-0 cannot reach either
# service and the API reports `model DOWN | assistant off` - two independent
# services failing together, which is the signature of the route being gone
# rather than the services.
#
# Safe to run when things are already up; every step checks first.
set -uo pipefail

HERE="$HOME"
TS_DIR="$(ls -d "$HERE"/tailscale_*_arm64 2>/dev/null | tail -1)"
REPO="$HERE/Projects/USTH/ProjectDR2026"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '   ok   %s\n' "$*"; }
bad() { printf '   !!   %s\n' "$*" >&2; }

# --------------------------------------------------------------- tailscale --
say "1/3  tailnet"
if [ -z "${TS_DIR:-}" ]; then
  bad "no tailscale_*_arm64 directory in \$HOME — cannot start the tailnet"
elif tmux has-session -t ts 2>/dev/null && [ -S /tmp/tailscaled.sock ]; then
  ok "tailscaled already running"
else
  tmux kill-session -t ts 2>/dev/null
  # A respawn loop, because there is no systemd here and no root to add one.
  # tailscaled was killed on 29 Sep 2026 with no shutdown line in its log, and
  # because nothing restarted it BOTH the grading path and the assistant path
  # went down at once and stayed down. Each restart writes a line, so a service
  # that is quietly dying and coming back reads as a crash loop in the log.
  tmux new -d -s ts "while true; do \
      '$TS_DIR/tailscaled' --tun=userspace-networking --socket=/tmp/tailscaled.sock \
        --state=$HERE/tailscaled.state >> $HERE/tailscaled.log 2>&1; \
      echo \"[respawn] tailscaled exited (\$?) at \$(date -Is) - restarting in 5s\" >> $HERE/tailscaled.log; \
      sleep 5; \
    done"
  sleep 5
  [ -S /tmp/tailscaled.sock ] && ok "started" || bad "no socket after 5s — see ~/tailscaled.log"
fi
if [ -n "${TS_DIR:-}" ]; then
  "$TS_DIR/tailscale" --socket=/tmp/tailscaled.sock status 2>/dev/null | head -3 | sed 's/^/        /'
fi

# ------------------------------------------------------------------ ollama --
say "2/3  ollama (the assistant)"
if curl -s -m 5 http://127.0.0.1:11434/api/tags | grep -q '"name"'; then
  ok "already answering"
else
  tmux has-session -t ollama 2>/dev/null || tmux new -d -s ollama 'ollama serve'
  sleep 5
  curl -s -m 5 http://127.0.0.1:11434/api/tags | grep -q '"name"' \
    && ok "started" \
    || bad "still no answer — run 'ollama serve' directly to see why"
fi
echo "        CHAT_MODEL on prts-0 must match one of these exactly:"
curl -s -m 5 http://127.0.0.1:11434/api/tags 2>/dev/null \
  | grep -o '"name":"[^"]*"' | head -6 | sed 's/^/        /'

# ------------------------------------------------------------- grading model --
say "3/3  grading model"
if tmux has-session -t retinax-ai 2>/dev/null; then
  ok "tmux retinax-ai already running"
  bash "$REPO/retinax-ai/run-on-dgx.sh" status
else
  bash "$REPO/retinax-ai/run-on-dgx.sh"
fi

echo
echo "   Expected: model on cuda, six lesion classes, and a warm-up line in the log."
echo "   Then on prts-0:  bash tools/start-all.sh"
