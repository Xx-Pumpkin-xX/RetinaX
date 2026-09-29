#!/usr/bin/env bash
#
# Bring prts-0 all the way up, in the order that works, checking each step
# before starting the next.
#
#   bash tools/start-all.sh
#
# Six processes make this system work and only two of them restart themselves.
# On 29 Sep 2026 an afternoon went into rediscovering that by hand, one failed
# symptom at a time, so this script exists to make the recovery two commands
# instead of eight - this one here, and its twin on the Spark.
#
# It is safe to run when things are already up: every step checks first and
# skips what is already running. What it will NOT do is open the vault, because
# that needs a passphrase that is deliberately not stored on this machine. It
# stops and tells you the one line to type.
set -uo pipefail

HERE="$HOME"
cd "$HERE"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '   ok   %s\n' "$*"; }
bad()  { printf '   !!   %s\n' "$*" >&2; }

# ---------------------------------------------------------------- host.env --
[ -f "$HERE/server/host.env" ] || { bad "no server/host.env — nothing can start without it"; exit 1; }
set -a; . "$HERE/server/host.env"; set +a
VAR_DIR="${VAR_DIR:?VAR_DIR is not set in host.env}"

# ------------------------------------------------------------------- vault --
say "1/5  vault"
if [ -f "$VAR_DIR/.vault-open" ] || mountpoint -q "$VAR_DIR" 2>/dev/null; then
  ok "open at $VAR_DIR  ($(ls "$VAR_DIR/uploads" 2>/dev/null | wc -l) photographs)"
else
  bad "the vault is closed. Open it, then run this again:"
  echo "        ~/bin/gocryptfs ~/retinax-vault $VAR_DIR"
  echo "     If it answers 'not empty', STOP and read docs/OPERATIONS.md — something"
  echo "     is already in the mountpoint and it is not your data."
  exit 1
fi

# --------------------------------------------------------- ollama bridge ----
say "2/5  assistant bridge"
if tmux has-session -t ollamaproxy 2>/dev/null; then
  ok "tmux ollamaproxy already running"
else
  tmux new -d -s ollamaproxy "python3 $HERE/tools/ollama-proxy.py"
  sleep 2
  tmux has-session -t ollamaproxy 2>/dev/null \
    && ok "started" \
    || bad "it exited immediately — run 'python3 ~/tools/ollama-proxy.py' to see why"
fi
if curl -s -m 5 http://127.0.0.1:11500/api/tags | grep -q '"name"'; then
  ok "the Spark's ollama answers through it"
else
  bad "no answer through the bridge — ollama on the Spark is probably not running."
  bad "the API will start anyway; the assistant will be off until it is."
fi

# --------------------------------------------------------------------- API --
say "3/5  API"
if tmux has-session -t retinax-api 2>/dev/null; then
  ok "tmux retinax-api already running"
else
  bash "$HERE/server/run-on-host.sh" >/dev/null || { bad "run-on-host.sh refused to start — run it directly to see why"; exit 1; }
  ok "started"
fi

# ------------------------------------------------------------------ tunnel --
say "4/5  public tunnel"
if tmux has-session -t cftunnel 2>/dev/null; then
  ok "tmux cftunnel already running — leaving the hostname alone"
else
  tmux new -d -s cftunnel \
    "cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:${PORT:-3000} 2>&1 | tee $HERE/cftunnel.log"
  printf '   ...  waiting for a hostname'
  for _ in $(seq 1 15); do
    sleep 2; printf '.'
    U="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$HERE/cftunnel.log" 2>/dev/null | tail -1)"
    [ -n "${U:-}" ] && break
  done
  echo
  if [ -z "${U:-}" ]; then
    bad "no hostname after 30s — check 'tmux attach -t cftunnel'"
  else
    ok "$U"
    sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$U|" "$HERE/server/host.env"
    ok "PUBLIC_URL updated in host.env"
    say "     >>> NOW SET THIS IN CLOUDFLARE PAGES, or the site cannot reach the API:"
    echo "         Settings -> Environment variables -> API_ORIGIN = $U"
    echo "         then Deployments -> Retry deployment"
  fi
fi

# ------------------------------------------------------------------ verify --
say "5/5  status"
bash "$HERE/server/run-on-host.sh" status
echo
tmux ls 2>/dev/null | sed 's/^/   tmux  /'
echo
echo "   Three sessions are expected: retinax-api, ollamaproxy, cftunnel."
echo "   'model DOWN' or 'assistant off' means the Spark is not reachable —"
echo "   run its own start-all there, or check tailscaled."
