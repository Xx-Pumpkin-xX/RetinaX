#!/usr/bin/env bash
# Pack the grading service for the Spark.
#
# Sibling of build-server-tar.sh, same discipline: stamp what is in the tar so
# the machine can say which code it is running, and refuse to ship secrets.
#
# The Spark and prts-0 are deployed SEPARATELY from the same commit — server/
# goes to prts-0, ai/ goes to the Spark. A change to one does not require
# redeploying the other, and confusing the two is how a fix gets shipped to the
# wrong machine and looks like it did nothing.
#
#     bash tools/build-ai-tar.sh
#
# Then upload to the Spark and, in the directory where ai/ already lives:
#
#     tar xzf ~/retinax-ai-<version>.tar.gz
#     bash ai/run-on-dgx.sh stop
#     bash ai/run-on-dgx.sh start
#     curl -s localhost:8000/health
#
# NEVER packs ai/dgx.env (tokens) or any .pth — the weights live on the Spark
# and are not ours to move.

set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname -- "$HERE")
cd "$ROOT"

if [ -n "${RX_VERSION:-}" ] || [ -n "${RX_COMMIT:-}" ]; then
  VERSION=${RX_VERSION:-unknown}; COMMIT=${RX_COMMIT:-unknown}; BRANCH=${RX_BRANCH:-unknown}
  echo "note: identity taken from RX_* environment, not from git." >&2
elif git rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT=$(git rev-parse --short HEAD)
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "$COMMIT")
  if [ -n "$(git status --porcelain -- ai 2>/dev/null)" ]; then
    echo "!! ai/ has uncommitted changes — the tar carries them and its version" >&2
    echo "   is marked -dirty. Commit first if this is meant to be a release." >&2
  fi
else
  COMMIT="nogit"; BRANCH="nogit"; VERSION="unknown"
fi
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > ai/BUILD <<STAMP
# Written by tools/build-ai-tar.sh. Not committed; regenerated every pack.
VERSION=$VERSION
COMMIT=$COMMIT
BRANCH=$BRANCH
BUILT_AT=$BUILT_AT
PACKED_BY=tar
STAMP

# CRLF in a shell script is not cosmetic. bash reads the carriage return as
# part of the last word on the line, so `set -o pipefail` becomes `pipefail\r`
# and the script dies at line 4 with a message naming neither the file nor the
# cause. A Windows checkout produces it silently, so the pack step is where it
# gets caught - once, for every host that will ever receive this tar.
find ai -name '*.sh' -print0 | xargs -0 -r sed -i 's/\r$//'

TAR="retinax-ai-$VERSION.tar.gz"
tar czf "$TAR" \
  --exclude=ai/dgx.env \
  --exclude=ai/__pycache__ \
  --exclude='ai/*.pth' \
  --exclude='ai/*.npy' \
  --exclude='*.pyc' \
  ai

if tar tzf "$TAR" | grep -E '(^|/)(dgx\.env|.*\.pth)$' ; then
  rm -f "$TAR"
  echo "!! refusing to ship: a secret or a checkpoint is in the tar (listed above)." >&2
  exit 1
fi

echo
echo "$TAR"
echo "  version   $VERSION"
echo "  commit    $COMMIT on $BRANCH"
echo "  built     $BUILT_AT"
echo "  size      $(du -h "$TAR" | cut -f1)"
echo "  files     $(tar tzf "$TAR" | wc -l | tr -d ' ')"
