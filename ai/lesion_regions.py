"""Turn six lesion masks into the `lesions` block that /infer returns.

WHAT THIS IS NOT
----------------
heatmap_regions.py reduces a GRADING model's attention to outlines. This file
reduces a SEGMENTATION model's output to outlines. They look the same on screen
and mean completely different things, which is why they travel in separate
fields, draw in separate colours, and are worded differently in the UI.

THE THIRD STATE
---------------
Every class reports one of three states, and the third is the reason this file
exists rather than a dict comprehension at the call site:

    found         the model ran and marked n areas
    none          the model ran and marked nothing - a real, measured zero
    not_assessed  no model ran, or its recall is not good enough to be believed

A class whose recall has not been measured on held-out data belongs in
NOT_CREDIBLE. It will then never report "none", because reporting a confident
zero for neovascularisation - the finding that decides urgent referral - is the
single most dangerous thing this screen could say. Move a key OUT of that set
only once you can quote its recall.

COORDINATES
-----------
Same frame as heatmap_regions.cam_regions: the ORIGINAL photograph's pixels,
mapped back through the same crop box. The browser places both with one SVG
viewBox, so a mismatch here points at the wrong part of the retina.
"""

import numpy as np

# The six FGADR classes, in the order the bar shows them.
CLASSES = ["MA", "HE", "EX", "SE", "IRMA", "NV"]

# Classes whose recall is not established. These report not_assessed no matter
# what their model outputs. Shrink this set with measurements, never with hope.
NOT_CREDIBLE = {"IRMA", "NV"}

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


def _circle(cx, cy, r, n=12):
    a = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    return [[int(round(cx + r * np.cos(t))), int(round(cy + r * np.sin(t)))] for t in a]


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
            polys.append(_circle(cx, cy, min_r))
            continue

        cc = pts.reshape(-1, 1, 2)
        eps = LESION_SIMPLIFY_FRAC * cv2.arcLength(cc, True)
        poly = cv2.approxPolyDP(cc, eps, True).reshape(-1, 2)
        if len(poly) < 3:
            continue
        polys.append([[int(round(x)), int(round(y))] for x, y in poly])

    return count, polys


def lesion_block(masks, size, box=None, grade=None, not_credible=NOT_CREDIBLE):
    """The whole `lesions` field for /infer.

    masks: {"MA": array|None, ...}. A key that is absent or None means no model
    ran for that class, which reports not_assessed - never "none".

    grade == 0 short-circuits the lot: the grading model found no retinopathy,
    so the lesion models are not run, and the screen must say so rather than
    printing six zeros nobody measured.
    """
    if grade == 0:
        return {
            "assessed": False,
            "reason": "grade_0",
            "classes": [
                {"key": k, "state": "not_assessed", "why": "grade_0",
                 "count": 0, "polygons": []}
                for k in CLASSES
            ],
        }

    masks = masks or {}
    out = []
    for k in CLASSES:
        if k in not_credible:
            out.append({"key": k, "state": "not_assessed",
                        "why": "recall_not_credible", "count": 0, "polygons": []})
            continue
        if masks.get(k) is None:
            out.append({"key": k, "state": "not_assessed", "why": "no_model",
                        "count": 0, "polygons": []})
            continue

        count, polys = lesion_regions(masks[k], size, box)
        out.append({
            "key": k,
            "state": "found" if count else "none",
            "count": count,
            "polygons": polys,
        })

    return {"assessed": True, "reason": None, "classes": out}
