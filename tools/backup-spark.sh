#!/usr/bin/env bash
#
# Chụp trạng thái máy Spark TRƯỚC khi tối ưu.
#
#   bash tools/backup-spark.sh              chụp code + cấu hình + mốc đo
#   bash tools/backup-spark.sh --weights    chép cả file trọng số (nặng, để tại chỗ)
#
# Chạy trên Spark, bằng tài khoản hungntt, từ thư mục chứa ai/.
#
# Weights KHÔNG được chép theo mặc định: chúng huấn luyện trên FGADR nên là tác
# phẩm phái sinh dưới thoả thuận đã ký, không rời máy này. Thay vào đó script
# ghi sha256 của từng file — đủ để chứng minh sau khi tối ưu trọng số còn nguyên
# hay đã bị thay.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$HOME/retinax-backups/spark-$STAMP"
WITH_WEIGHTS=0
[ "${1:-}" = "--weights" ] && WITH_WEIGHTS=1
PORT="${PORT:-8000}"

mkdir -p "$OUT/baseline"
echo "chụp vào $OUT"

# ---- cấu hình: tên biến và dấu vân tay, không bao giờ là giá trị -------------
if [ -f "$HERE/ai/dgx.env" ]; then
  set -a; . "$HERE/ai/dgx.env"; set +a
  cut -d= -f1 "$HERE/ai/dgx.env" | grep -v '^#' | grep . | sort > "$OUT/dgx.env.keys"
  sha256sum "$HERE/ai/dgx.env" | awk '{print $1}' > "$OUT/dgx.env.sha256"
  echo "  cấu hình: $(wc -l < "$OUT/dgx.env.keys") biến, đã ghi vân tay"
else
  echo "  !! không thấy ai/dgx.env — mốc đo sẽ thiếu đường dẫn model" >&2
fi

# ---- code ------------------------------------------------------------------
tar czf "$OUT/ai-code.tar.gz" -C "$HERE" \
    --exclude='ai/__pycache__' --exclude='ai/.ipynb_checkpoints' \
    --exclude='ai/*.env' --exclude='ai/weights' --exclude='ai/*.pth' \
    --exclude='ai/*.pt' --exclude='ai/*.onnx' --exclude='ai/*.log' \
    ai
echo "  code: $(du -h "$OUT/ai-code.tar.gz" | cut -f1)"

# ---- trọng số: vân tay, không phải bản sao ----------------------------------
{
  echo "# sha256  bytes  sửa lần cuối  đường dẫn"
  for f in "${MODEL_PATH:-}" "${THRESHOLD_PATH:-}"; do
    [ -n "$f" ] && [ -f "$f" ] && \
      printf '%s  %s  %s  %s\n' "$(sha256sum "$f" | awk '{print $1}')" \
        "$(stat -c%s "$f")" "$(stat -c%y "$f" | cut -d. -f1)" "$f"
  done
  for d in "$HERE/ai/weights" "${DR_REPO:-}/src/experiments"; do
    [ -n "$d" ] && [ -d "$d" ] && find "$d" -type f \( -name '*.pth' -o -name '*.pt' -o -name '*.npy' -o -name '*.onnx' \) -print0 \
      | while IFS= read -r -d '' f; do
          printf '%s  %s  %s  %s\n' "$(sha256sum "$f" | awk '{print $1}')" \
            "$(stat -c%s "$f")" "$(stat -c%y "$f" | cut -d. -f1)" "$f"
        done
  done
} > "$OUT/weights.manifest" 2>/dev/null || true
echo "  trọng số: $(($(wc -l < "$OUT/weights.manifest") - 1)) file đã ghi vân tay"

if [ "$WITH_WEIGHTS" = "1" ]; then
  mkdir -p "$OUT/weights"
  awk 'NR>1{print $4}' "$OUT/weights.manifest" | while read -r f; do
    [ -f "$f" ] && cp -n "$f" "$OUT/weights/" 2>/dev/null || true
  done
  echo "  đã chép $(ls "$OUT/weights" 2>/dev/null | wc -l) file trọng số — KHÔNG mang bản này ra khỏi máy"
fi

# ---- môi trường ------------------------------------------------------------
{
  echo "== ngày chụp: $(date -Iseconds)"
  echo "== máy: $(hostname) | $(uname -srm)"
  echo; echo "== python"; python3 -V 2>&1
  echo; echo "== gpu"; nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv 2>&1 | head -5
  echo; echo "== torch"; python3 -c 'import torch;print(torch.__version__, "cuda", torch.version.cuda, "avail", torch.cuda.is_available())' 2>&1
} > "$OUT/environment.txt"
pip freeze > "$OUT/pip-freeze.txt" 2>/dev/null || pip3 freeze > "$OUT/pip-freeze.txt" 2>/dev/null || true
echo "  môi trường: $(wc -l < "$OUT/pip-freeze.txt" 2>/dev/null || echo 0) gói"

# ---- mốc đo: câu trả lời của model TRƯỚC khi tối ưu -------------------------
# Đây mới là phần quan trọng nhất. Tối ưu mà làm đổi grade thì không phải tối ưu,
# mà là lỗi hồi quy — và chỉ so được nếu có bản ghi từ trước.
curl -s -m 10 "http://localhost:$PORT/health" > "$OUT/baseline/health.json" 2>/dev/null \
  || echo '{"error":"service không trả lời"}' > "$OUT/baseline/health.json"

IMGDIR="${BASELINE_IMAGES:-$HERE/ai/baseline-images}"
if [ -d "$IMGDIR" ]; then
  n=0
  for img in "$IMGDIR"/*.{png,jpg,jpeg,PNG,JPG} ; do
    [ -f "$img" ] || continue
    name="$(basename "${img%.*}")"
    t0=$(date +%s%N)
    curl -s -m 120 -F "image=@$img" "http://localhost:$PORT/infer" > "$OUT/baseline/infer-$name.json" 2>/dev/null || true
    t1=$(date +%s%N)
    echo "$name $(( (t1-t0)/1000000 ))" >> "$OUT/baseline/latency-ms.txt"
    n=$((n+1))
  done
  echo "  mốc đo: $n ảnh đã chấm, thời gian ghi ở baseline/latency-ms.txt"
else
  echo "  !! chưa có $IMGDIR — mốc đo model bị bỏ qua." >&2
  echo "     Tạo thư mục đó, bỏ vào 5-10 ảnh đáy mắt cố định rồi chạy lại." >&2
fi

# ---- tóm tắt ---------------------------------------------------------------
{
  echo "RetinaX — ảnh chụp Spark trước khi tối ưu"
  echo "thời điểm : $(date -Iseconds)"
  echo "máy       : $(hostname)"
  echo "thư mục   : $OUT"
  echo
  echo "có gì     : ai-code.tar.gz, weights.manifest (vân tay), environment.txt,"
  echo "            pip-freeze.txt, dgx.env.keys + .sha256, baseline/"
  echo "KHÔNG có  : giá trị trong dgx.env, và trọng số (trừ khi chạy --weights)"
  echo
  echo "khôi phục code : tar xzf ai-code.tar.gz -C <repo>"
  echo "kiểm trọng số  : sha256sum -c <(awk 'NR>1{print \$1\"  \"\$4}' weights.manifest)"
  echo "so mốc đo      : python3 tools/compare-baseline.py <thư mục này>/baseline <thư mục mới>/baseline"
} > "$OUT/SUMMARY.txt"
cat "$OUT/SUMMARY.txt"
