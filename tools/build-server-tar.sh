#!/usr/bin/env bash
# Pack the API for prts-0.
#
# prts-0 has no git checkout — it is deployed by unpacking a tar — so the tar
# has to carry its own identity. This script stamps server/BUILD with the
# version, commit, branch and build time, and /api/health reports them back.
# That is how you answer "is prts-0 running the code I just pushed?" without
# guessing from behaviour.
#
# Run it on prts (Git Bash), or anywhere with the repo and git:
#
#     bash tools/build-server-tar.sh
#     bash tools/build-server-tar.sh --with-demo-images    # first deploy only
#
# Then upload the tar to prts-0 through JupyterLab and, on prts-0:
#
#     cd ~          # on prts-0 server/ and tools/ live in $HOME, not in a repo dir
#     tar xzf ~/retinax-server-<version>.tar.gz
#     bash server/run-on-host.sh stop
#     bash server/run-on-host.sh start
#     bash tools/status.sh
#
# It NEVER packs .env, host.env, dgx.env, the database, the uploaded images or
# node_modules, and it aborts if one slips in anyway.

set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname -- "$HERE")
cd "$ROOT"

WITH_IMAGES=0
[ "${1:-}" = "--with-demo-images" ] && WITH_IMAGES=1

# ---------------------------------------------------------------- identity ---
# RX_VERSION / RX_COMMIT / RX_BRANCH override everything below. Use them when
# packing from somewhere that has the files but not the history — otherwise let
# git answer, because git cannot be wrong about what is committed.
if [ -n "${RX_VERSION:-}" ] || [ -n "${RX_COMMIT:-}" ]; then
  VERSION=${RX_VERSION:-$(node -p "require('./server/package.json').version" 2>/dev/null || echo unknown)}
  COMMIT=${RX_COMMIT:-unknown}
  BRANCH=${RX_BRANCH:-unknown}
  echo "note: identity taken from RX_* environment, not from git." >&2
elif git rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT=$(git rev-parse --short HEAD)
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "$COMMIT")
  if [ -n "$(git status --porcelain -- server tools 2>/dev/null)" ]; then
    echo "!! server/ or tools/ has uncommitted changes." >&2
    echo "   The tar will carry them, and its version is marked -dirty so you" >&2
    echo "   can tell later. Commit first if this is meant to be a release." >&2
  fi
else
  COMMIT="nogit"; BRANCH="nogit"
  VERSION=$(node -p "require('./server/package.json').version" 2>/dev/null || echo "unknown")
  echo "note: not a git checkout — stamping version $VERSION only." >&2
fi
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > server/BUILD <<STAMP
# Written by tools/build-server-tar.sh. Not committed; regenerated every pack.
VERSION=$VERSION
COMMIT=$COMMIT
BRANCH=$BRANCH
BUILT_AT=$BUILT_AT
PACKED_BY=tar
STAMP

# ------------------------------------------------------------------- pack ----
TAR="retinax-server-$VERSION.tar.gz"
EXCLUDES=(
  --exclude=server/node_modules
  --exclude=server/data
  --exclude=server/uploads
  --exclude=server/.env
  --exclude=server/host.env
  --exclude=.DS_Store
  --exclude='*.pyc'
  --exclude=__pycache__
)
[ "$WITH_IMAGES" = "1" ] || EXCLUDES+=(--exclude=server/demo-images)

tar czf "$TAR" "${EXCLUDES[@]}" server tools

# ------------------------------------------------------------------ verify ---
# A secret in a deploy tar is the kind of mistake you only notice later, so
# check rather than trust the exclude list.
if tar tzf "$TAR" | grep -E '(^|/)(\.env|host\.env|dgx\.env)$' ; then
  rm -f "$TAR"
  echo "!! refusing to ship: the tar contained an env file (listed above)." >&2
  exit 1
fi

echo
echo "$TAR"
echo "  version   $VERSION"
echo "  commit    $COMMIT on $BRANCH"
echo "  built     $BUILT_AT"
echo "  demo imgs $([ "$WITH_IMAGES" = 1 ] && echo included || echo "excluded (--with-demo-images to add)")"
echo "  size      $(du -h "$TAR" | cut -f1)"
echo "  files     $(tar tzf "$TAR" | wc -l | tr -d ' ')"
