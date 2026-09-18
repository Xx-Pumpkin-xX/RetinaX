"""Turn six lesion masks into the `lesions` block that /infer returns.

WHAT THIS IS NOT
----------------
heatmap_regions.py reduces a GRADING model's attention to outlines. This file
reduces a SEGMENTATION model's output to outlines. They look the same on screen
and mean completely different things, which is why they travel in separate
fields, draw in separate colours, and are worded differently in the UI.

ALL SIX CLASSES RUN. NOT ALL SIX MAY SAY "NO".
----------------------------------------------
Every class that has a model is evaluated and, if it marks anything, those
marks reach the screen. What differs between classes is the right to report an
ABSENCE:

    found         the model marked n areas
    none          the model ran, marked nothing, and is trusted to mean it
    not_assessed  no model, or a model whose silence proves nothing

The asymmetry is the point. A positive mark is a suggestion the clinician can
look at and dismiss in a second. A reported absence is a claim they cannot
check - and for neovascularisation, the finding that decides urgent referral,
a model with 25% recall is wrong three times out of four when it says nothing.
So low-confidence classes may point, but may not reassure.

WHICH CLASS IS TRUSTED IS MEASURED, NOT DECIDED HERE
----------------------------------------------------
load_metrics() reads lesion_level.json, written by ai/eval_lesion_level.py.
A class earns `established` by clearing MIN_RECALL on at least MIN_GT_LESIONS
ground-truth lesions; everything else is `provisional`. With no metrics file at
all, nothing is established and every silent class reports not_assessed - the
screen can only claim what a measurement on disk supports. Retrain, re-run the
eval, and the UI follows the new numbers without anyone editing this file.

COORDINATES
-----------
Same frame as heatmap_regions.cam_regions: the ORIGINAL photograph's pixels,
mapped back through the same crop box. The browser places both with one SVG
viewBox, so a mismatch here points at the wrong part of the retina.
"""

import json
from pathlib import Path

import numpy as np

CLASSES = ["MA", "HE", "EX", "SE", "IRMA", "NV"]

LABELS = {
    "MA": "Microaneurysms",
    "HE": "Haemorrhages",
    "EX": "Hard exudates",
    "SE": "Soft exudates",
    "IRMA": "IRMA",
    "NV": "Neovascularisation",
}

# The bar for being allowed to report an absence. Both must hold: a good recall
# measured on a handful of lesions is not a good recall, it is a small sample.
MIN_RECALL = 0.50
MIN_GT_LESIONS = 200

LESION_PROB = 0.50          # sigmoid level counted as lesion
LESION_MIN_AREA_PX = 4      # on the mask's own grid; a microaneurysm is tiny
LESION_SIMPLIFY_FRAC = 0.02
MAX_POLYS = 200             # drawn; `count` still reports everything found

# A 4-pixel blob mapped onto a 3388-pixel-wide photograph draws as a dot you
# cannot see. Anything smaller than this fraction of the image width is emitted
# as a circle of exactly this radius instead of its traced boundary: the mark
# then POINTS AT the lesion rather than tracing it. Said out loud because a
# viewer must not read these small circles as measured extents.
MIN_RADIUS_FRAC = 0.006


# ------------------------------------------------------------- reliability ---
def load_metrics(weights_dir, threshold=LESION_PROB, filename="lesion_level.json"):
    """{key: {recall, precision, gt_lesions, tier}} from the eval output.

    Returns {} when the file is missing or unreadable, which makes every class
    provisional - the safe direction. A missing measurement must never read as
    a passing one.
    """
    if not weights_dir:
        return {}
    path = Path(weights_dir) / filename
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return {}

    key_thr = f"{float(threshold):.2f}"
    out = {}
    for key, entry in (raw or {}).items():
        row = (entry.get("by_threshold") or {}).get(key_thr)
        if not row:
            continue
        recall = row.get("lesion_recall")
        gt = row.get("gt_lesions") or 0
        tier = ("established"
                if recall is not None and recall >= MIN_RECALL and gt >= MIN_GT_LESIONS
                else "provisional")
        out[key] = {
            "recall": recall,
            "precision": row.get("lesion_precision"),
            "gt_lesions": gt,
            "val_images": entry.get("val_images"),
            "threshold": float(threshold),
            "tier": tier,
        }
    return out


# ------------------------------------------------------------- geometry -----
def _clamp(points, W, H):
    """Every emitted point inside the photograph.

    The browser draws these in an SVG whose viewBox IS the photograph, so a
    negative y is not clipped - it is drawn hanging off the top edge, pointing
    at nothing. A lesion near the rim produces exactly that, because _circle
    expands a fixed radius around a centroid that may sit two pixels from the
    border.
    """
    return [[min(max(int(round(x)), 0), int(W) - 1),
             min(max(int(round(y)), 0), int(H) - 1)] for x, y in points]


def _circle(cx, cy, r, n=12):
    a = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    return [[cx + r * np.cos(t), cy + r * np.sin(t)] for t in a]


def lesion_regions(mask, size, box=None, prob=LESION_PROB, max_polys=MAX_POLYS):
    """(count, polygons) for one class. `count` is every component found."""
    import cv2

    if mask is None:
        return 0, []

    m = np.asarray(mask, dtype=np.float32)
    if m.ndim == 3:
        m = m[0] if m.shape[0] == 1 else m[..., 0]
    h, w = m.shape

    binary = (m >= prob).astype(np.uint8)
    if binary.sum() == 0:
        return 0, []

    n, labels, stats, cent = cv2.connectedComponentsWithStats(binary, connectivity=8)

    keep = []
    for i in range(1, n):
        area = float(stats[i, cv2.CC_STAT_AREA])
        if area < LESION_MIN_AREA_PX:
            continue
        keep.append((area, i))
    if not keep:
        return 0, []

    count = len(keep)
    keep.sort(reverse=True)

    W, H = size
    if box is None:
        sx, sy, ox, oy = W / w, H / h, 0.0, 0.0
    else:
        y0, y1, x0, x1 = box
        sx, sy, ox, oy = (x1 - x0) / w, (y1 - y0) / h, float(x0), float(y0)

    min_r = MIN_RADIUS_FRAC * float(W)

    polys = []
    for _, i in keep[:max_polys]:
        comp = (labels == i).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)

        # Straight to the photograph's frame, then decide whether the shape is
        # big enough to be worth tracing. Deciding on the mask's grid would use
        # the wrong scale, and the two grids differ by more than 5x.
        pts = c.reshape(-1, 2).astype(np.float32)
        pts[:, 0] = pts[:, 0] * sx + ox
        pts[:, 1] = pts[:, 1] * sy + oy

        x0p, y0p = pts[:, 0].min(), pts[:, 1].min()
        x1p, y1p = pts[:, 0].max(), pts[:, 1].max()
        if max(x1p - x0p, y1p - y0p) < 2 * min_r:
            cx = float(cent[i][0]) * sx + ox
            cy = float(cent[i][1]) * sy + oy
            polys.append(_clamp(_circle(cx, cy, min_r), W, H))
            continue

        cc = pts.reshape(-1, 1, 2)
        eps = LESION_SIMPLIFY_FRAC * cv2.arcLength(cc, True)
        poly = cv2.approxPolyDP(cc, eps, True).reshape(-1, 2)
        if len(poly) < 3:
            continue
        polys.append(_clamp(poly, W, H))

    return count, polys


# --------------------------------------------------------------- contract ---
def _entry(key, state, count=0, polys=None, why=None, m=None):
    out = {
        "key": key,
        "label": LABELS[key],
        "state": state,
        "count": count,
        "polygons": polys or [],
        "reliability": (m or {}).get("tier", "unmeasured"),
    }
    if m:
        out["recall"] = m.get("recall")
        out["precision"] = m.get("precision")
        out["gt_lesions"] = m.get("gt_lesions")
        out["val_images"] = m.get("val_images")
    if why:
        out["why"] = why
    return out


def lesion_block(masks, size, box=None, grade=None, metrics=None):
    """The whole `lesions` field for /infer.

    masks:   {"MA": array|None, ...}. Absent or None means no model ran.
    metrics: load_metrics(<weights dir>). Absent means nothing is established,
             so no class may report an absence.

    grade == 0 short-circuits the lot: the grading model found no retinopathy,
    so the lesion models are not run, and the screen says so rather than
    printing six zeros nobody measured.
    """
    metrics = metrics or {}

    if grade == 0:
        return {
            "assessed": False,
            "reason": "grade_0",
            "classes": [_entry(k, "not_assessed", why="grade_0",
                               m=metrics.get(k)) for k in CLASSES],
        }

    masks = masks or {}
    out = []
    for k in CLASSES:
        m = metrics.get(k)

        if masks.get(k) is None:
            out.append(_entry(k, "not_assessed", why="no_model", m=m))
            continue

        count, polys = lesion_regions(masks[k], size, box)

        if count:
            # Anything the model actually marked is shown, whatever its tier.
            # A mark is a suggestion the clinician can look at and reject.
            out.append(_entry(k, "found", count, polys, m=m))
            continue

        # Silence. Only a class measured well enough is allowed to mean it.
        if m and m.get("tier") == "established":
            out.append(_entry(k, "none", m=m))
        else:
            out.append(_entry(k, "not_assessed",
                              why="low_recall" if m else "unmeasured", m=m))

    return {"assessed": True, "reason": None, "classes": out}
