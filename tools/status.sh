#!/usr/bin/env bash
# One command that answers "is RetinaX up?" from either machine.
#
# Run it from a JupyterLab terminal, or from a notebook cell:
#
#     !bash ~/RetinaX.ai/tools/status.sh
#
# It never changes anything and never needs root. It checks, in order:
#   1. the tmux sessions that hold each service
#   2. whether anything is listening on the two ports, locally
#   3. the model service   GET /health        (port 8000)
#   4. the API             GET /api/health    (port 3000) — including WHICH BUILD
#      it is running, compared against the checkout you are standing in
#   5. the other machine across Tailscale, if tailscale is installed
#   6. the public tunnel, if NGROK_DOMAIN or PUBLIC_URL is set
#
# Override any of these before the command if your ports differ:
#   MODEL_PORT=8000 API_PORT=3000 PEER=spark-063e bash tools/status.sh
#
# Exit code is 0 when both services answered, 1 when either did not, so a
# notebook cell shows a red mark when something is down.

set -u

MODEL_PORT=${MODEL_PORT:-8000}
API_PORT=${API_PORT:-3000}
TIMEOUT=${TIMEOUT:-8}

# Load whichever env file is next to the repo, so AI_URL / NGROK_DOMAIN come
# from the same place the run scripts read them from. Never fails if absent.
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname -- "$HERE")
for f in "$ROOT/server/host.env" "$ROOT/ai/dgx.env"; do
  # shellcheck disable=SC1090
  [ -r "$f" ] && . "$f" 2>/dev/null
done

ok=0; bad=0
green() { printf '  \033[32m%s\033[0m %s\n' "UP" "$*"; ok=$((ok+1)); }
red()   { printf '  \033[31m%s\033[0m %s\n' "--" "$*"; bad=$((bad+1)); }
grey()  { printf '     %s\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }

hostname_short=$(hostname 2>/dev/null || echo "this machine")
printf '\033[1mRetinaX status\033[0m   %s   %s\n' "$hostname_short" "$(date '+%Y-%m-%d %H:%M:%S')"

# ---------------------------------------------------------------- 1. tmux ----
head2 "tmux sessions"
if command -v tmux >/dev/null 2>&1; then
  for s in retinax-ai retinax-api; do
    if tmux has-session -t "$s" 2>/dev/null; then
      green "$s   ($(tmux list-panes -t "$s" 2>/dev/null | wc -l | tr -d ' ') pane(s))"
    else
      red "$s   not running on this machine"
    fi
  done
  grey "attach with:  tmux attach -t retinax-ai     (detach: Ctrl-b then d)"
else
  grey "tmux is not installed here"
fi

# --------------------------------------------------------------- 2. ports ----
head2 "listening ports on this machine"
listening() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q ":$1 "
  elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | grep -q ":$1 "
  else return 2; fi
}
for p in "$MODEL_PORT:model" "$API_PORT:api"; do
  port=${p%%:*}; name=${p##*:}
  listening "$port"
  case $? in
    0) green "$port   $name" ;;
    1) red   "$port   $name   nothing bound here" ;;
    *) grey  "$port   $name   (no ss/netstat to check with)" ;;
  esac
done

# ------------------------------------------------------- 3 & 4. the services --
# Pull one top-level string field out of a JSON body, without needing jq.
# Tries python3, then node, then a regex — one of the three exists on every
# machine we run on, and the regex is enough for the flat objects /health emits.
jsonfield() {  # jsonfield <json> <key>
  local body=$1 key=$2
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$body" | python3 -c \
      "import json,sys;print(json.load(sys.stdin).get('$key',''))" 2>/dev/null && return
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$body" | node -e \
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s)['$key']??''))}catch{}})" 2>/dev/null && return
  fi
  printf '%s' "$body" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}]*\).*/\1/p" | head -1
}

probe() {  # probe <label> <url>
  local label=$1 url=$2 body
  body=$(curl -fsS -m "$TIMEOUT" -H 'ngrok-skip-browser-warning: 1' "$url" 2>&1)
  if [ $? -ne 0 ]; then
    red "$label   no answer   $url"
    grey "$(printf '%s' "$body" | head -1)"
    return 1
  fi
  green "$label   $url"
  printf '%s' "$body" | head -c 400 | sed 's/^/       /'
  echo
  return 0
}

head2 "model service"
probe "health" "http://localhost:$MODEL_PORT/health"
grey "model_loaded must be true, and thresholds_source must say best_thresholds.npy"
grey "— if it says 'default', the Nelder-Mead thresholds did not load and every"
grey "  grade will be wrong in the same direction."

head2 "API"
API_BODY=$(curl -fsS -m "$TIMEOUT" "http://localhost:$API_PORT/api/health" 2>/dev/null || true)
if [ -n "$API_BODY" ]; then
  green "health   http://localhost:$API_PORT/api/health"
  printf '%s' "$API_BODY" | head -c 400 | sed 's/^/       /'; echo
else
  # a build older than the version stamp has no /api/health at all;
  # a 401 from /api/cases still proves the API is up and authenticating
  code=$(curl -s -o /dev/null -w '%{http_code}' -m "$TIMEOUT" "http://localhost:$API_PORT/api/cases" 2>/dev/null)
  if [ "$code" = "401" ]; then
    green "api      up on :$API_PORT  (401 from /api/cases — auth is working)"
    grey "no /api/health — this box predates the version stamp, so it is behind."
  else
    red "health   no answer   http://localhost:$API_PORT/api/health"
  fi
fi

# ------------------------------------------------------------- 4b. build ----
head2 "which build is the API running"
if [ -n "$API_BODY" ]; then
  RUN_VER=$(jsonfield "$API_BODY" version)
  RUN_SHA=$(jsonfield "$API_BODY" commit)
  RUN_BRANCH=$(jsonfield "$API_BODY" branch)
  RUN_BUILT=$(jsonfield "$API_BODY" builtAt)
  RUN_HOW=$(jsonfield "$API_BODY" packedBy)
  grey "version  ${RUN_VER:-unknown}"
  grey "commit   ${RUN_SHA:-unknown} on ${RUN_BRANCH:-unknown}"
  grey "built    ${RUN_BUILT:-unknown}   (deployed by ${RUN_HOW:-unknown})"

  # Only meaningful when this machine also holds the source.
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    HEAD_SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "")
    if [ -z "$RUN_SHA" ] || [ "$RUN_SHA" = "unknown" ]; then
      grey "checkout here is $HEAD_SHA; the server does not report a commit."
    elif [ "$RUN_SHA" = "$HEAD_SHA" ]; then
      green "matches the checkout here ($HEAD_SHA)"
    else
      red "BEHIND — this checkout is $HEAD_SHA, the server is running $RUN_SHA"
      grey "rebuild and redeploy:  bash tools/build-server-tar.sh"
    fi
  fi
else
  red "cannot tell — the API did not answer"
fi

# ----------------------------------------------------------- 5. the peer -----
head2 "the other machine"
if command -v tailscale >/dev/null 2>&1; then
  tailscale status 2>/dev/null | sed 's/^/  /' | head -10
  peer=${PEER:-}
  if [ -z "$peer" ]; then
    case "$hostname_short" in
      *spark*) peer=prts-0 ;;
      *)       peer=$(tailscale status 2>/dev/null | awk '/spark/{print $2; exit}') ;;
    esac
  fi
  if [ -n "$peer" ]; then
    case "$hostname_short" in
      *spark*) probe "peer api  " "http://$peer:$API_PORT/api/health" ;;
      *)       probe "peer model" "http://$peer:$MODEL_PORT/health" ;;
    esac
  fi
else
  grey "tailscale is not on PATH here"
  [ -n "${AI_URL:-}" ] && probe "AI_URL" "$AI_URL/health"
fi

# --------------------------------------------------------- 6. the tunnel -----
PUBLIC=${PUBLIC_URL:-}
[ -z "$PUBLIC" ] && [ -n "${NGROK_DOMAIN:-}" ] && PUBLIC="https://$NGROK_DOMAIN"
if [ -n "$PUBLIC" ]; then
  head2 "public tunnel"
  probe "public" "$PUBLIC/api/health"
  grey "this is what retinax.pages.dev talks to — if it is down, the site is down"
fi

# ------------------------------------------------------------- the verdict ---
echo
if [ "$bad" -eq 0 ]; then
  printf '\033[32mAll %d checks answered.\033[0m\n' "$ok"
  exit 0
fi
printf '\033[31m%d check(s) did not answer.\033[0m  %d did.\n' "$bad" "$ok"
echo "Start what is missing:   bash server/run-on-host.sh start     (on prts-0)"
echo "                         bash ai/run-on-dgx.sh   start     (on the Spark)"
exit 1
