#!/usr/bin/env bash
#
# Chụp trạng thái prts-0 TRƯỚC khi tối ưu.
#
#   cd ~ && bash server/../tools/backup-prts0.sh
#   (hoặc từ repo: bash tools/backup-prts0.sh)
#
# Gồm ba phần: dữ liệu (qua snapshot.sh, nằm trong vault), code + cấu hình
# (không kèm giá trị bí mật), và mốc đo hiệu năng để sau biết tối ưu có ăn thua.
set -euo pipefail

HOME_DIR="$HOME"
SRV="$HOME_DIR/server"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$HOME_DIR/retinax-backups/prts0-$STAMP"
PORT="${PORT:-3000}"

[ -d "$SRV" ] || { echo "!! không thấy $SRV" >&2; exit 1; }
mkdir -p "$OUT/baseline"
echo "chụp vào $OUT"

# ---- 1. dữ liệu: dùng đúng công cụ sẵn có, và nó ghi vào trong vault --------
if [ -f "$HOME_DIR/retinax-data/.vault-open" ]; then
  # tools/snapshot.sh, không phải bản lẻ ở $HOME: bản lẻ là di tích từ thời
  # mỗi script chỉ tồn tại một bản trên một máy, và nó không được cập nhật nữa.
  # SNAPSHOT_DIR đưa bản sao vào TRONG vault — mặc định của snapshot.sh là
  # ~/retinax-snapshots, tức database và toàn bộ ảnh đáy mắt nằm trần trên đĩa.
  ( cd "$HOME_DIR" && set -a && . server/host.env && set +a \
    && SNAPSHOT_DIR="$VAR_DIR/snapshots" bash tools/snapshot.sh save "pre-opt-$STAMP" ) \
    && echo "  dữ liệu: snapshot pre-opt-$STAMP"
else
  echo "  !! vault chưa mount — BỎ QUA phần dữ liệu." >&2
  echo "     gocryptfs ~/retinax-vault ~/retinax-data rồi chạy lại." >&2
fi

# ---- 2. code và cấu hình ---------------------------------------------------
tar czf "$OUT/server.tar.gz" -C "$HOME_DIR" \
    --exclude='server/node_modules' --exclude='server/data' --exclude='server/uploads' \
    --exclude='server/*.env' --exclude='server/.ipynb_checkpoints' --exclude='server/*.log' \
    server $( [ -d "$HOME_DIR/tools" ] && echo tools )
# Từ tools/, nơi chúng thật sự sống. Vòng lặp cũ đọc ở $HOME và sẽ lặng lẽ
# không sao chép gì sau khi mấy bản lẻ ở đó bị dọn đi.
for f in snapshot.sh ollama-proxy.py seed-cases.mjs purge-demo.js reset-cases.js purge-doctors.js; do
  [ -f "$HOME_DIR/tools/$f" ] && cp "$HOME_DIR/tools/$f" "$OUT/" 2>/dev/null || true
done
echo "  code: $(du -h "$OUT/server.tar.gz" | cut -f1)"

# Cấu hình: chỉ tên biến và dấu vân tay. Giá trị ở lại trên máy này.
if [ -f "$SRV/host.env" ]; then
  cut -d= -f1 "$SRV/host.env" | grep -v '^#' | grep . | sort > "$OUT/host.env.keys"
  sha256sum "$SRV/host.env" | awk '{print $1}' > "$OUT/host.env.sha256"
  dup=$(sort "$OUT/host.env.keys" | uniq -d)
  [ -n "$dup" ] && echo "  !! host.env có key trùng: $dup" >&2
  echo "  cấu hình: $(wc -l < "$OUT/host.env.keys") biến, đã ghi vân tay"
fi
cp "$SRV/BUILD" "$OUT/BUILD" 2>/dev/null || true

# ---- 3. môi trường ---------------------------------------------------------
{
  echo "== ngày chụp: $(date -Iseconds)"
  echo "== máy: $(hostname) | $(uname -srm)"
  echo "== node: $(node -v 2>&1) | npm: $(npm -v 2>&1)"
  echo "== bộ nhớ:"; free -h 2>/dev/null | head -2
  echo "== đĩa:"; df -h "$HOME_DIR" 2>/dev/null | tail -1
  echo "== tiến trình node:"; pgrep -af 'node server.js' | sed 's/JWT_SECRET=[^ ]*/JWT_SECRET=<ẩn>/g; s/API_PROXY_SECRET=[^ ]*/API_PROXY_SECRET=<ẩn>/g; s/GMAIL_[A-Z_]*=[^ ]*/GMAIL_*=<ẩn>/g'
} > "$OUT/environment.txt" 2>&1
( cd "$SRV" && npm ls --depth=0 ) > "$OUT/npm-tree.txt" 2>&1 || true

# kích thước dữ liệu — để sau biết tối ưu có làm nhẹ đi không
if [ -d "$HOME_DIR/retinax-data" ]; then
  {
    echo "database : $(du -h "$HOME_DIR/retinax-data/data/retinax.db" 2>/dev/null | cut -f1)"
    echo "uploads  : $(du -sh "$HOME_DIR/retinax-data/uploads" 2>/dev/null | cut -f1) ($(ls "$HOME_DIR/retinax-data/uploads" 2>/dev/null | wc -l) file)"
    echo "vault    : $(du -sh "$HOME_DIR/retinax-vault" 2>/dev/null | cut -f1)"
  } > "$OUT/data-size.txt"
fi

# ---- 4. mốc đo hiệu năng ---------------------------------------------------
# Đo cái mà việc tối ưu định cải thiện. Không có số trước thì sau đó chỉ còn
# cảm giác, mà cảm giác thì luôn thấy nhanh hơn.
measure() {   # tên, url, số lần
  local name="$1" url="$2" n="${3:-20}" i t0 t1
  : > "$OUT/baseline/$name.ms"
  for i in $(seq 1 "$n"); do
    t0=$(date +%s%N); curl -s -o /dev/null -m 15 "$url"; t1=$(date +%s%N)
    echo $(( (t1-t0)/1000000 )) >> "$OUT/baseline/$name.ms"
  done
  sort -n "$OUT/baseline/$name.ms" | awk -v N="$name" '
    {a[NR]=$1} END{ printf "%-18s p50=%sms  p95=%sms  max=%sms  (n=%d)\n",
      N, a[int(NR*0.5)+0==0?1:int(NR*0.5)], a[int(NR*0.95)==0?1:int(NR*0.95)], a[NR], NR }'
}
{
  echo "== mốc đo $(date -Iseconds)"
  curl -s -m 10 "http://localhost:$PORT/api/health" > "$OUT/baseline/health.json" 2>/dev/null || true
  echo "health.json: $(head -c 200 "$OUT/baseline/health.json" 2>/dev/null)"
  echo
  measure api-health  "http://localhost:$PORT/api/health" 30
  measure api-cases   "http://localhost:$PORT/api/cases"  30
  U="$(grep -m1 '^PUBLIC_URL=' "$SRV/host.env" 2>/dev/null | cut -d= -f2-)"
  [ -n "${U:-}" ] && measure tunnel-health "${U%/}/api/health" 10
  echo
  echo "model:"; curl -s -m 10 "${AI_URL:-http://100.126.54.48:8000}/health" | head -c 400; echo
} > "$OUT/baseline/timings.txt" 2>&1
cat "$OUT/baseline/timings.txt"

# ---- tóm tắt ---------------------------------------------------------------
{
  echo "RetinaX — ảnh chụp prts-0 trước khi tối ưu"
  echo "thời điểm : $(date -Iseconds)"
  echo "thư mục   : $OUT"
  echo "snapshot  : pre-opt-$STAMP (trong vault, khôi phục bằng snapshot.sh)"
  echo
  echo "có gì     : server.tar.gz, BUILD, host.env.keys + .sha256, npm-tree.txt,"
  echo "            environment.txt, data-size.txt, baseline/timings.txt"
  echo "KHÔNG có  : giá trị trong host.env, database và ảnh (chúng ở trong vault)"
  echo
  echo "lùi code  : cd ~ && tar xzf $OUT/server.tar.gz && bash server/run-on-host.sh stop && bash server/run-on-host.sh start"
  echo "lùi dữ liệu: cd ~ && set -a && . server/host.env && set +a && bash snapshot.sh restore pre-opt-$STAMP"
  echo "kiểm cấu hình chưa bị đổi: sha256sum ~/server/host.env | awk '{print \$1}' | diff - $OUT/host.env.sha256"
} > "$OUT/SUMMARY.txt"
echo; cat "$OUT/SUMMARY.txt"
