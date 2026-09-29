#!/usr/bin/env python3
"""So hai thư mục baseline: trước tối ưu và sau tối ưu.

    python3 tools/compare-baseline.py <baseline-cũ> <baseline-mới>

Trả lời đúng hai câu hỏi, theo thứ tự đó:

  1. Kết quả chấm có đổi không?  Một tối ưu làm đổi grade không phải là tối ưu,
     mà là lỗi hồi quy. Câu này phải trả lời TRƯỚC khi ai đó khoe con số tốc độ.
  2. Có nhanh lên thật không?   So p50 và p95, không so lần chạy đơn lẻ.

Thoát với mã 1 nếu phát hiện kết quả chấm bị đổi.
"""
import json, sys, os, glob, statistics as st

def pct(v, p):
    if not v: return None
    v = sorted(v)
    return v[min(int(len(v) * p), len(v) - 1)]

def load_infer(d):
    out = {}
    for f in sorted(glob.glob(os.path.join(d, "infer-*.json"))):
        name = os.path.basename(f)[len("infer-"):-len(".json")]
        try:
            out[name] = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            out[name] = {"__loi__": str(e)}
    return out

def lesion_counts(o):
    les = o.get("lesions") or {}
    if isinstance(les, dict):
        return {k: (v.get("count") if isinstance(v, dict) else v) for k, v in sorted(les.items())}
    return {}

def load_ms(d):
    out = {}
    for f in glob.glob(os.path.join(d, "*.ms")):
        vals = [int(x) for x in open(f).read().split() if x.strip().isdigit()]
        if vals: out[os.path.basename(f)[:-3]] = vals
    lat = os.path.join(d, "latency-ms.txt")
    if os.path.exists(lat):
        vals = [int(l.split()[-1]) for l in open(lat) if l.split() and l.split()[-1].isdigit()]
        if vals: out["infer"] = vals
    return out

def main(a, b):
    bad = 0
    print(f"cũ : {a}\nmới: {b}\n")

    ia, ib = load_infer(a), load_infer(b)
    if ia or ib:
        print("── kết quả chấm ─────────────────────────────────────────")
        only_a = sorted(set(ia) - set(ib)); only_b = sorted(set(ib) - set(ia))
        if only_a: print(f"  !! mất khỏi bản mới: {', '.join(only_a)}"); bad += 1
        if only_b: print(f"  .. chỉ có ở bản mới: {', '.join(only_b)}")
        same = 0
        for k in sorted(set(ia) & set(ib)):
            ga, gb = ia[k].get("grade"), ib[k].get("grade")
            la, lb = lesion_counts(ia[k]), lesion_counts(ib[k])
            if ga != gb:
                print(f"  !! {k}: GRADE ĐỔI  {ga} -> {gb}"); bad += 1
            elif la != lb:
                diff = {c: (la.get(c), lb.get(c)) for c in set(la) | set(lb) if la.get(c) != lb.get(c)}
                print(f"  !  {k}: grade giữ nguyên ({ga}) nhưng đếm tổn thương đổi: {diff}"); bad += 1
            else:
                same += 1
        print(f"  {same}/{len(set(ia) & set(ib))} ảnh cho kết quả y hệt\n")

    ma, mb = load_ms(a), load_ms(b)
    if ma or mb:
        print("── thời gian (ms) ───────────────────────────────────────")
        print(f"  {'phép đo':<18}{'p50 cũ':>8}{'p50 mới':>9}{'':>3}{'p95 cũ':>8}{'p95 mới':>9}")
        for k in sorted(set(ma) & set(mb)):
            p50a, p50b = pct(ma[k], .5), pct(mb[k], .5)
            p95a, p95b = pct(ma[k], .95), pct(mb[k], .95)
            d = (p50b - p50a) / p50a * 100 if p50a else 0
            tag = "nhanh hơn" if d <= -5 else ("chậm hơn" if d >= 5 else "như cũ")
            print(f"  {k:<18}{p50a:>8}{p50b:>9}   {p95a:>8}{p95b:>9}   {d:+6.0f}%  {tag}")
        print()

    if bad:
        print(f"KẾT LUẬN: {bad} khác biệt về kết quả chấm. Đây là hồi quy, không phải tối ưu.")
        print("Phải giải thích được từng dòng trước khi nhận bản tối ưu.")
        return 1
    print("KẾT LUẬN: kết quả chấm không đổi. Giờ mới xét tới con số tốc độ.")
    return 0

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
