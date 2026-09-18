"""Lesion-level metrics: did we find the lesion, not did we trace it.

WHY THIS EXISTS
---------------
train_lesions.py reports PIXEL metrics, and for microaneurysms those are
misleading in a specific direction. An MA is a few dozen pixels. Predict it two
pixels off-centre and pixel-recall collapses while the mark still lands on the
lesion - which is all the UI claims, because lesion_regions.py draws a circle
that POINTS AT small lesions rather than tracing them.

So the number that should decide whether a class leaves NOT_CREDIBLE is this
one: of the lesions that are there, how many did we put a mark on.

MATCHING RULE
-------------
A ground-truth component counts as found if any predicted pixel lands inside
it. A predicted component counts as a true positive if it overlaps any
ground-truth component. Permissive on purpose: it measures pointing, not
outlining. Predicted components smaller than lesion_regions.LESION_MIN_AREA_PX
are dropped first, so this measures what actually reaches the screen.

SAME VAL SET AS TRAINING
------------------------
The split is rebuilt from <KEY>.split.json and the same two seeds train_one
used, so these numbers are on exactly the images the model never saw. If the
cache is missing the script refuses rather than inventing a different split -
evaluating on a different set than you trained on is how a good number gets
reported for a bad model.

    python3 eval_lesion_level.py --root data/raw/FGADR --weights ~/lesion-weights
    python3 eval_lesion_level.py --root data/raw/FGADR --weights ~/lesion-weights --only MA
"""

import argparse, json, random, sys
from pathlib import Path

import cv2
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_lesions import CLASSES, discover, pairs, LesionSet   # noqa: E402


def build_bare(encoder):
    """No imagenet fetch: load_state_dict overwrites every weight anyway, and
    the download attempt only costs a timeout and a frightening warning."""
    import segmentation_models_pytorch as smp
    return smp.Unet(encoder_name=encoder, encoder_weights=None,
                    in_channels=3, classes=1)

MIN_AREA_PX = 4          # must match lesion_regions.LESION_MIN_AREA_PX
THRESHOLDS = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70]


def val_items(key, items, weights):
    """The exact val split train_one used. Refuses to guess."""
    cache = Path(weights) / f"{key}.split.json"
    if not cache.exists():
        raise SystemExit(f"!! {cache} missing - cannot reproduce the split")
    want = set(json.loads(cache.read_text())["positive"])

    pos, neg = [], []
    for ip, mp in items:
        (pos if str(ip) in want else neg).append((ip, mp))
    random.Random(0).shuffle(neg)
    use = pos + neg[: len(pos)]
    random.Random(1).shuffle(use)
    cut = max(1, int(len(use) * 0.15))
    return use[:cut]


def components(binary, min_area):
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    return [(labels == i) for i in range(1, n)
            if stats[i, cv2.CC_STAT_AREA] >= min_area]


def score_one(prob, truth, thr):
    """(gt_total, gt_found, pred_total, pred_true) for one image."""
    gt = components((truth > 0.5).astype(np.uint8), 1)
    pred = components((prob >= thr).astype(np.uint8), MIN_AREA_PX)
    if not gt and not pred:
        return 0, 0, 0, 0

    hit = np.zeros_like(truth, dtype=bool)
    for p in pred:
        hit |= p

    found = sum(1 for g in gt if (g & hit).any())
    true_pred = sum(1 for p in pred if any((p & g).any() for g in gt))
    return len(gt), found, len(pred), true_pred


def evaluate(key, root, weights, size_override=None, batch=4):
    ck_path = Path(weights) / f"{key}.pth"
    if not ck_path.exists():
        return None
    ck = torch.load(ck_path, map_location="cpu", weights_only=False)

    found_dirs = discover(root)
    if key not in found_dirs:
        return None
    items = val_items(key, pairs(*found_dirs[key]), weights)

    size = size_override or ck.get("size", 512)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    model = build_bare(ck.get("encoder", "resnet34"))
    model.load_state_dict(ck["state_dict"])
    model.to(device).eval()

    ds = LesionSet(items, size, False)
    tally = {t: [0, 0, 0, 0] for t in THRESHOLDS}

    with torch.no_grad():
        for i in range(0, len(ds), batch):
            chunk = [ds[j] for j in range(i, min(i + batch, len(ds)))]
            x = torch.from_numpy(np.stack([c[0] for c in chunk])).to(device)
            y = np.stack([c[1][0] for c in chunk])
            with torch.autocast("cuda", enabled=device.type == "cuda"):
                p = torch.sigmoid(model(x)).float().cpu().numpy()[:, 0]
            for k in range(len(chunk)):
                for t in THRESHOLDS:
                    a, b, c, d = score_one(p[k], y[k], t)
                    tally[t][0] += a; tally[t][1] += b
                    tally[t][2] += c; tally[t][3] += d

    out = {}
    for t, (gt, gt_found, pred, pred_true) in tally.items():
        rec = gt_found / gt if gt else None
        pre = pred_true / pred if pred else None
        out[f"{t:.2f}"] = {
            "lesion_recall": None if rec is None else round(rec, 4),
            "lesion_precision": None if pre is None else round(pre, 4),
            "gt_lesions": gt, "gt_found": gt_found,
            "predicted": pred, "predicted_true": pred_true,
        }
    return {"key": key, "val_images": len(items), "size": size, "by_threshold": out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--size", type=int, default=0)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    wanted = CLASSES
    if args.only:
        pick = {k.strip().upper() for k in args.only.split(",")}
        wanted = [k for k in CLASSES if k in pick]

    every = {}
    for k in wanted:
        try:
            r = evaluate(k, args.root, args.weights, args.size or None, args.batch)
        except Exception as e:
            print(f"{k}: failed - {e}")
            continue
        if r is None:
            print(f"{k}: no weights")
            continue
        every[k] = r
        print(f"\n== {k}   {r['val_images']} val images @ {r['size']}px")
        print(f"   {'thr':>5} {'recall':>8} {'prec':>8}   {'found/total':>14}  {'marks':>6}")
        for t, m in r["by_threshold"].items():
            rec = "  n/a" if m["lesion_recall"] is None else f"{m['lesion_recall']:.3f}"
            pre = "  n/a" if m["lesion_precision"] is None else f"{m['lesion_precision']:.3f}"
            print(f"   {t:>5} {rec:>8} {pre:>8}   "
                  f"{m['gt_found']:>6}/{m['gt_lesions']:<7} {m['predicted']:>6}")

    if args.out and every:
        Path(args.out).write_text(json.dumps(every, indent=2))
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
