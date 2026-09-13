#!/usr/bin/env bash
# One command that answers "is RetinaX up, and which build?"
#
# Run it from a JupyterLab terminal, or from a notebook cell:
#
#     !bash ~/tools/status.sh
#
# It never changes anything and never needs root.
#
# IT KNOWS WHAT THIS MACHINE IS FOR. prts-0 runs the API and reaches the model
# across Tailscale; the Spark runs the model and no API. A machine is judged
# only on the services it is supposed to be running, because a check that goes
# red when everything is correct teaches you to ignore red.
#
# The role is read from the filesystem: server/run-on-host.sh here means this
# box serves the API, ai/run-on-dgx.sh means it serves the model. Override with
# ROLE=api | model | both if you ever need to.
#
# Checks, in order:
#   1. the tmux sessions this machine is supposed to hold
#   2. the ports this machine is supposed to have bound
#   3. the model     GET $AI_URL/health      (local or across Tailscale)
#   4. the API       GET /api/health         — and WHICH BUILD it is running,
#      compared against the checkout you are standing in
#   5. the other machines on the tailnet
#   6. the public tunnel, if NGROK_DOMAIN or PUBLIC_URL is set
#
# Overrides:
#   MODEL_PORT=8000 API_PORT=3000 AI_URL=http://spark-063e:8000 ROLE=api
#
# Exit code is 0 when everything this machine owns answered, 1 otherwise, so a
# notebook cell shows a red mark only when something is actually wrong.

set -u

MODEL_PORT=${MODEL_PORT:-8000}
API_PORT=${API_PORT:-3000}
TIMEOUT=${TIMEOUT:-8}

# Find the install root whether the layout is ~/RetinaX.ai/tools or just ~/tools.
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname -- "$HERE")

# Read the same env files the run scripts read, so AI_URL and NGROK_DOMAIN come
# from one place. Never fails if they are absent.
#
# Anything the caller set on the command line has to survive this. Sourcing a
# file that assigns AI_URL would otherwise silently overwrite the override the
# header tells you to use, and you would be told about a machine you did not ask
# about — so the caller's values are saved and put back afterwards.
_preset_ai=${AI_URL:-}
_preset_ngrok=${NGROK_DOMAIN:-}
for f in "$ROOT/server/host.env" "$ROOT/ai/dgx.env"; do
  # shellcheck disable=SC1090
  [ -r "$f" ] && . "$f" 2>/dev/null
done
[ -n "$_preset_ai" ]    && AI_URL=$_preset_ai
[ -n "$_preset_ngrok" ] && NGROK_DOMAIN=$_preset_ngrok

# ------------------------------------------------------------ this machine ---
ROLE=${ROLE:-}
if [ -z "$ROLE" ]; then
  has_api=0; has_model=0
  [ -f "$ROOT/server/run-on-host.sh" ] && has_api=1
  [ -f "$ROOT/ai/run-on-dgx.sh" ]      && has_model=1
  if   [ "$has_api" = 1 ] && [ "$has_model" = 1 ]; then ROLE=both
  elif [ "$has_api" = 1 ];                        then ROLE=api
  elif [ "$has_model" = 1 ];                      then ROLE=model
  else ROLE=both   # nothing recognisable here: check everything, judge nothing
  fi
fi
case "$ROLE" in
  api)   OWNS_API=1; OWNS_MODEL=0 ;;
  model) OWNS_API=0; OWNS_MODEL=1 ;;
  *)     OWNS_API=1; OWNS_MODEL=1 ;;
esac

# Where the model actually is. On prts-0 host.env sets AI_URL to the Spark's
# Tailscale name, so "localhost:8000 is not answering" is the wrong question.
MODEL_URL=${AI_URL:-http://localhost:$MODEL_PORT}
MODEL_URL=${MODEL_URL%/}
case "$MODEL_URL" in
  *localhost*|*127.0.0.1*) MODEL_IS_LOCAL=1 ;;
  *)                       MODEL_IS_LOCAL=0 ;;
esac

ok=0; bad=0
green() { printf '  \033[32m%s\033[0m %s\n' "UP" "$*"; ok=$((ok+1)); }
red()   { printf '  \033[31m%s\033[0m %s\n' "--" "$*"; bad=$((bad+1)); }
grey()  { printf '     %s\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }

hostname_short=$(hostname 2>/dev/null || echo "this machine")
printf '\033[1mRetinaX status\033[0m   %s   %s\n' "$hostname_short" "$(date '+%Y-%m-%d %H:%M:%S')"
case "$ROLE" in
  api)   grey "role: the API. The model lives on another machine, at $MODEL_URL." ;;
  model) grey "role: the grading model. The API lives on another machine." ;;
  both)  grey "role: both services on this machine." ;;
esac

# Pull one top-level field out of a JSON body, without needing jq. Tries
# python3, then node, then a regex — one of the three exists on every machine we
# run on, and the regex is enough for the flat objects /health emits.
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

fetch() { curl -fsS -m "$TIMEOUT" -H 'ngrok-skip-browser-warning: 1' "$1" 2>/dev/null; }

probe() {  # probe <label> <url>   — counts toward the verdict
  local label=$1 url=$2 body
  body=$(fetch "$url") || { red "$label   no answer   $url"; return 1; }
  green "$label   $url"
  printf '%s' "$body" | head -c 400 | sed 's/^/       /'; echo
  return 0
}

note_probe() {  # same, but informational: never counts against the verdict
  local label=$1 url=$2 body
  body=$(fetch "$url") || { grey "$label   no answer   $url"; return 1; }
  grey "$label   $url"
  printf '%s' "$body" | head -c 300 | sed 's/^/       /'; echo
  return 0
}

# ---------------------------------------------------------------- 1. tmux ----
head2 "tmux sessions"
if command -v tmux >/dev/null 2>&1; then
  check_session() {  # check_session <name> <owned 0|1> <elsewhere-text>
    if tmux has-session -t "$1" 2>/dev/null; then
      green "$1   ($(tmux list-panes -t "$1" 2>/dev/null | wc -l | tr -d ' ') pane(s))"
    elif [ "$2" = 1 ]; then
      red "$1   NOT running, and this machine is supposed to run it"
    else
      grey "$1   not here — $3"
    fi
  }
  check_session retinax-api "$OWNS_API"   "the API host runs this"
  check_session retinax-ai  "$OWNS_MODEL" "the Spark runs this"
  [ "$OWNS_API" = 1 ] && MINE=retinax-api || MINE=retinax-ai
  grey "attach with:  tmux attach -t $MINE     (detach: Ctrl-b then d)"
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
check_port() {  # check_port <port> <name> <owned 0|1>
  listening "$1"
  case $? in
    0) green "$1   $2" ;;
    1) if [ "$3" = 1 ]; then red "$1   $2   nothing bound here"
       else grey "$1   $2   not here, as expected"; fi ;;
    *) grey "$1   $2   (no ss/netstat to check with)" ;;
  esac
}
check_port "$API_PORT"   "api  " "$OWNS_API"
check_port "$MODEL_PORT" "model" "$OWNS_MODEL"

# --------------------------------------------------------------- 3. model ----
head2 "grading model"
[ "$MODEL_IS_LOCAL" = 1 ] || grey "on another machine: $MODEL_URL"
if probe "health" "$MODEL_URL/health"; then
  H=$(fetch "$MODEL_URL/health")
  [ "$(jsonfield "$H" model_loaded)" = "True" ] || [ "$(jsonfield "$H" model_loaded)" = "true" ] \
    || red "model_loaded is not true — new uploads will fail"
  TS=$(jsonfield "$H" thresholds_source)
  case "$TS" in
    *best_thresholds.npy*) grey "thresholds from best_thresholds.npy — correct" ;;
    "")                    grey "no thresholds_source field — older build" ;;
    *) red "thresholds_source is '$TS', not best_thresholds.npy"
       grey "the Nelder-Mead thresholds did not load: every grade is wrong in"
       grey "the same direction, and nothing else looks broken." ;;
  esac
else
  grey "existing cases still open fine; only NEW uploads need the model."
fi

# ----------------------------------------------------------------- 4. API ----
head2 "API"
API_BODY=$(fetch "http://localhost:$API_PORT/api/health" || true)
if [ -n "$API_BODY" ]; then
  green "health   http://localhost:$API_PORT/api/health"
  printf '%s' "$API_BODY" | head -c 400 | sed 's/^/       /'; echo
elif [ "$OWNS_API" = 1 ]; then
  # a build older than the version stamp has no /api/health at all;
  # a 401 from /api/cases still proves the API is up and authenticating
  code=$(curl -s -o /dev/null -w '%{http_code}' -m "$TIMEOUT" "http://localhost:$API_PORT/api/cases" 2>/dev/null)
  if [ "$code" = "401" ]; then
    green "api      up on :$API_PORT  (401 from /api/cases — auth is working)"
    grey "no /api/health — this box predates the version stamp, so it is behind."
  else
    red "health   no answer   http://localhost:$API_PORT/api/health"
  fi
else
  grey "no API here, as expected"
fi

# --------------------------------------------------------------- 4b. build ---
if [ -n "$API_BODY" ]; then
  head2 "which build is the API running"
  RUN_SHA=$(jsonfield "$API_BODY" commit)
  grey "version  $(jsonfield "$API_BODY" version)"
  grey "commit   ${RUN_SHA:-unknown} on $(jsonfield "$API_BODY" branch)"
  grey "built    $(jsonfield "$API_BODY" builtAt)   (deployed by $(jsonfield "$API_BODY" packedBy))"
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    HEAD_SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "")
    if [ -z "$RUN_SHA" ] || [ "$RUN_SHA" = "unknown" ] || [ "$RUN_SHA" = "uncommitted" ]; then
      grey "checkout here is $HEAD_SHA; the running build reports no real commit."
    elif [ "$RUN_SHA" = "$HEAD_SHA" ]; then
      green "matches the checkout here ($HEAD_SHA)"
    else
      red "BEHIND — this checkout is $HEAD_SHA, the server is running $RUN_SHA"
      grey "rebuild and redeploy:  bash tools/build-server-tar.sh"
    fi
  fi
fi

# ---------------------------------------------------------- 5. the tailnet ---
head2 "the tailnet"
if command -v tailscale >/dev/null 2>&1; then
  tailscale status 2>/dev/null | sed 's/^/  /' | head -10
else
  grey "tailscale is not on PATH here"
fi

# --------------------------------------------------------- 6. the tunnel -----
PUBLIC=${PUBLIC_URL:-}
[ -z "$PUBLIC" ] && [ -n "${NGROK_DOMAIN:-}" ] && PUBLIC="https://$NGROK_DOMAIN"
if [ -n "$PUBLIC" ]; then
  head2 "public tunnel"
  if [ "$OWNS_API" = 1 ]; then
    probe "public" "${PUBLIC%/}/api/health"
  else
    note_probe "public" "${PUBLIC%/}/api/health"
  fi
  grey "this is what retinax.pages.dev talks to — if it is down, the site is down"
fi

# ------------------------------------------------------------- the verdict ---
echo
if [ "$bad" -eq 0 ]; then
  printf '\033[32mAll %d checks passed for this machine (%s).\033[0m\n' "$ok" "$ROLE"
  exit 0
fi
printf '\033[31m%d check(s) failed.\033[0m  %d passed.\n' "$bad" "$ok"
[ "$OWNS_API" = 1 ]   && echo "  start the API:    bash server/run-on-host.sh start"
[ "$OWNS_MODEL" = 1 ] && echo "  start the model:  bash ai/run-on-dgx.sh start"
[ "$OWNS_MODEL" = 0 ] && echo "  the model runs on the Spark: bash ai/run-on-dgx.sh start, there"
exit 1
