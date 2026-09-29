#!/usr/bin/env bash
#
# Save and restore the whole RetinaX state: the database AND the photographs.
#
# Deleting a case is permanent by design — no bin, no soft delete, and the
# files are unlinked with the rows. That is right for a clinical record and
# wrong for a demo you are still rehearsing, where "I clicked the wrong thing"
# should cost seconds and not a twelve-minute re-grade of every image.
#
# So: take a snapshot when the worklist looks the way you want it to look for
# the presentation, and put it back whenever it does not.
#
#   bash snapshot.sh save [name]      default name: the timestamp
#   bash snapshot.sh list
#   bash snapshot.sh restore <name>
#
# Run it the way the API runs, so it finds the same VAR_DIR:
#
#   cd ~ && set -a && . server/host.env && set +a && bash snapshot.sh save demo
#
# Without host.env, VAR_DIR is unset, the script looks in ./data and ./uploads,
# finds an empty pair, and cheerfully snapshots nothing.
set -euo pipefail

VAR_DIR="${VAR_DIR:-.}"
DB="$VAR_DIR/data/retinax.db"
UP="$VAR_DIR/uploads"
STORE="${SNAPSHOT_DIR:-$HOME/retinax-snapshots}"
CMD="${1:-}"

die() { echo "!! $*" >&2; exit 1; }

case "$CMD" in
save)
  NAME="${2:-$(date +%Y%m%d-%H%M%S)}"
  [ -f "$DB" ] || die "no database at $DB — did you source host.env?"
  mkdir -p "$STORE/$NAME"

  # The DATABASE FIRST, and through sqlite3 .backup rather than cp: .backup
  # takes a read lock and produces a file that is consistent even while the API
  # is serving. A plain cp of a live SQLite file can catch it mid-write.
  sqlite3 "$DB" ".backup '$STORE/$NAME/retinax.db'"

  # Photographs SECOND, and the order matters. An upload that lands between the
  # two steps becomes a file with no row — litter, invisible, harmless. The
  # reverse order would give a row with no file, which is a broken image on the
  # case screen and looks like a bug.
  tar czf "$STORE/$NAME/uploads.tar.gz" -C "$VAR_DIR" uploads

  CASES=$(sqlite3 "$STORE/$NAME/retinax.db" "SELECT COUNT(*) FROM cases;")
  WITH=$(sqlite3 "$STORE/$NAME/retinax.db" \
         "SELECT COUNT(*) FROM predictions WHERE Lesions IS NOT NULL;")
  printf '%s\n' "saved $NAME" \
    "  $CASES cases, $WITH predictions carry a lesion block" \
    "  $(du -sh "$STORE/$NAME" | cut -f1)  at $STORE/$NAME" \
    "" \
    "restore with:  bash snapshot.sh restore $NAME"
  ;;

list)
  [ -d "$STORE" ] || die "no snapshots yet at $STORE"
  for d in "$STORE"/*/; do
    [ -f "$d/retinax.db" ] || continue
    n=$(sqlite3 "$d/retinax.db" "SELECT COUNT(*) FROM cases;" 2>/dev/null || echo "?")
    printf '  %-24s %4s cases   %s\n' "$(basename "$d")" "$n" \
           "$(date -r "$d/retinax.db" '+%Y-%m-%d %H:%M')"
  done
  ;;

restore)
  NAME="${2:-}"
  [ -n "$NAME" ] || die "usage: bash snapshot.sh restore <name>"
  SRC="$STORE/$NAME"
  [ -f "$SRC/retinax.db" ] || die "no snapshot called $NAME (try: bash snapshot.sh list)"

  # The API holds the database open. Restoring underneath a running process
  # leaves it reading a file that no longer exists.
  echo "stopping the API…"
  bash server/run-on-host.sh stop || true

  # What is there now is moved aside, never deleted. Restoring the wrong
  # snapshot should be as recoverable as everything else here.
  ASIDE="$STORE/_replaced-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$ASIDE"
  [ -f "$DB" ] && sqlite3 "$DB" ".backup '$ASIDE/retinax.db'"
  [ -d "$UP" ] && tar czf "$ASIDE/uploads.tar.gz" -C "$VAR_DIR" uploads
  echo "current state parked at $ASIDE"

  rm -f "$DB-wal" "$DB-shm"
  cp "$SRC/retinax.db" "$DB"
  rm -rf "$UP"
  tar xzf "$SRC/uploads.tar.gz" -C "$VAR_DIR"

  echo "starting the API…"
  bash server/run-on-host.sh start

  echo
  echo "restored $NAME — $(sqlite3 "$DB" 'SELECT COUNT(*) FROM cases;') cases"
  ;;

*)
  die "usage: bash snapshot.sh {save [name] | list | restore <name>}"
  ;;
esac
