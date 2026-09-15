"""
Deciding whether an activation map is worth showing, and reducing it to regions.

TWO PROBLEMS THIS SOLVES, BOTH CAUSED BY THE SAME LINE

dr_adapter._as_map ends with

    (a - lo) / (hi - lo)

so every map is min-max stretched to fill 0..1. Whatever the model actually
felt — a strong response to real lesions, or flat noise on a healthy retina —
the brightest pixel is painted the same deep red. **The map has no "nothing
here" state.** On a grade-0 eye the maximum lands wherever the noise happened
to peak, very often on the crop boundary, where the black border meets the
retina and produces a gradient the network reacts to.

So:

1. `suppress_reason` decides when the map is not evidence and should not be
   drawn at all. Showing a confident red blob to a clinician when the model
   found nothing is worse than showing nothing — it invents a finding.

2. `cam_regions` reduces a map that IS worth showing to a few boxes around its
   strongest areas, because a wash over the whole retina says "somewhere" and
   a clinician needs "here".

A WARNING ABOUT BOXES

A rectangle is a stronger claim than a blob. A blurry wash says "roughly in
this direction"; a crisp box says "it is in here". This CAM comes from a
GRADING model, not a lesion detector — it shows where the network's evidence
for a grade concentrated, which is correlated with lesions but is not a lesion
segmentation. So the boxes are deliberately padded rather than tight, and the
field is named `regions`, not `lesions`. Label them in the UI as attention
regions, and never as detected lesions.
"""
import numpy as np

# Fraction of the map's total activation that must fall inside the retina for
# the map to be considered about the retina at all. Below this it is mostly
# reacting to the crop edge or the black border.
FOV_HEAT_MIN = 0.60

# Pixels above this quantile OF THE ACTIVATION INSIDE THE RETINA become
# candidate regions. 0.95 keeps the top 5%.
#
# Widened from 0.98. At the top 2% only the single strongest focus survived on
# most images, so one area got marked on a retina the model had reacted to in
# several places. That mark is not wrong, but it is badly incomplete, and a
# clinician reading it as "this is what it found" is reading it wrong. Going
# much below 0.95 is not free: the regions merge into one blob covering half
# the retina, which says nothing.
REGION_QUANTILE = 0.95
# Where the outline is cut, as a level on the jet colormap the overlay is
# painted with. jet runs blue -> cyan -> green -> yellow -> red: about 0.5 is
# mid green, 0.75 yellow-orange, and 0.9 and up is red.
#
# 0.50 - mid green and hotter. Started at 0.80 (red only), which on most images
# left a single small mark: the true peak is a few pixels wide, and outlining
# only that says the model looked at one spot when it responded across a whole
# area. Cutting at green takes in the shoulder of each response, which is the
# extent a reader actually wants. The cost is real and worth stating: the lower
# the cut, the more neighbouring responses merge into one region, and below
# about 0.45 they fuse into a single blob covering much of the retina.
#
# This is an ABSOLUTE level on the map, not a quantile, and that is the point:
# the outline then traces exactly the red area a clinician can see in the CAM
# view. The two views become the same statement shown twice, rather than two
# thresholds that happen to disagree. The quantile above survives only as a
# fallback for a map with no red in it at all.
HOT_LEVEL = 0.50
# The traced boundary is grown by this many pixels of the map's own grid, for
# the same reason the boxes were padded: the CAM is coarse - a 600px input
# downsampled to the last conv layer - and a boundary drawn tight to the
# threshold implies a precision it does not have. Dilating the mask rather than
# scaling the polygon keeps the shape instead of distorting long thin regions.
REGION_GROW_PX = 2
# Contour points are reduced to this fraction of the region's perimeter, which
# takes the pixel staircase off the outline without rounding away its shape.
REGION_SIMPLIFY_FRAC = 0.004
# A region smaller than this fraction of the retina is noise, not a finding.
# Lowered fourfold alongside the quantile: microaneurysms are small, and a
# filter tuned to drop noise was dropping them too.
REGION_MIN_AREA_FRAC = 0.0002
# Boxes are grown by this fraction of their size, because the CAM is coarse
# (a 600px input downsampled to the last conv layer) and a tight box implies a
# precision the map does not have.
REGION_PAD_FRAC = 0.25
MAX_REGIONS = 8


def fov_mask(rgb, tol=7):
    """Boolean mask of the retina: everything brighter than `tol` in grayscale.

    Deliberately the same rule as dr_adapter.gray_crop_box, and deliberately
    NOT preprocessing/fov_mask.py — that module's circle fitting has only ever
    been tested on synthetic images (see scripts/validate_fov_on_fgadr.py,
    written and never run). An untested mask must not be what decides whether a
    clinician sees an explanation.
    """
    import cv2
    gray = cv2.cvtColor(np.asarray(rgb, dtype=np.uint8), cv2.COLOR_RGB2GRAY)
    return gray > tol


def fov_heat_fraction(cam, mask):
    """How much of the map's total activation sits inside the retina."""
    cam = np.asarray(cam, dtype=np.float32)
    if mask.shape != cam.shape:
        import cv2
        mask = cv2.resize(mask.astype(np.uint8), (cam.shape[1], cam.shape[0]),
                          interpolation=cv2.INTER_NEAREST).astype(bool)
    total = float(cam.sum())
    if total <= 1e-8:
        return 0.0
    return float(cam[mask].sum()) / total


def suppress_reason(cam, grade, rgb=None, fov_heat_min=FOV_HEAT_MIN):
    """Why this map should not be shown, or None if it should.

    Returns (reason, fov_fraction). Reasons:
      "grade_0"     the model reports no retinopathy, so there is no finding
                    for a map to point at. Anything it highlights is noise
                    that normalisation has painted red.
      "outside_fov" most of the activation is off the retina — the crop edge,
                    the black border — so the map is about the photograph's
                    geometry, not the eye.

    Grade 1 is NOT suppressed on grade alone: mild NPDR is defined by
    microaneurysms, which are real findings a clinician wants located. It still
    has to pass the FOV check like any other grade.
    """
    if cam is None:
        return "no_map", 0.0
    if grade == 0:
        frac = fov_heat_fraction(cam, fov_mask(rgb)) if rgb is not None else 1.0
        return "grade_0", frac
    if rgb is None:
        return None, 1.0
    frac = fov_heat_fraction(cam, fov_mask(rgb))
    if frac < fov_heat_min:
        return "outside_fov", frac
    return None, frac


def cam_regions(cam, size, box=None, rgb=None,
                quantile=REGION_QUANTILE, min_area_frac=REGION_MIN_AREA_FRAC,
                pad_frac=REGION_PAD_FRAC, max_regions=MAX_REGIONS):
    """Reduce an activation map to outlines around its red areas.

    `size` is (width, height) of the ORIGINAL photograph and `box` the crop
    offset (y0, y1, x0, x1) from dr_adapter.gray_crop_box, so the returned
    coordinates are in the photograph's own frame — the same transform
    cam_to_png does when it pastes the overlay.

    The threshold is a quantile of the activation INSIDE the retina, not of the
    whole map: including the black border drags the quantile down and every
    region grows to swallow the frame.
    """
    import cv2
    if cam is None:
        return []
    cam = np.clip(np.asarray(cam, dtype=np.float32), 0.0, 1.0)
    h, w = cam.shape

    inside = fov_mask(rgb) if rgb is not None else np.ones((h, w), dtype=bool)
    if inside.shape != cam.shape:
        inside = cv2.resize(inside.astype(np.uint8), (w, h),
                            interpolation=cv2.INTER_NEAREST).astype(bool)
    values = cam[inside]
    if values.size == 0:
        return []

    # The level cut first. If nothing inside the retina reaches it - which
    # happens on a flat response - fall back to the quantile so the caller
    # still gets the strongest areas rather than nothing.
    binary = ((cam >= HOT_LEVEL) & inside).astype(np.uint8)
    if binary.sum() == 0:
        thr = float(np.quantile(values, quantile))
        binary = ((cam >= thr) & inside).astype(np.uint8)
    if binary.sum() == 0:
        return []
    if REGION_GROW_PX > 0:
        # An ELLIPSE kernel, not a square one: a square structuring element
        # squares off round blobs, and the outline then looks like the box we
        # just stopped drawing.
        k = 2 * REGION_GROW_PX + 1
        binary = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        binary = (binary & inside.astype(np.uint8))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    min_area = max(1.0, min_area_frac * float(inside.sum()))

    found = []
    for i in range(1, n):
        area = float(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        x, y = int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP])
        bw, bh = int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT])
        peak = float(cam[labels == i].max())

        # The region's own boundary, traced. Deliberately NOT a convex hull:
        # a hull bridges across the gap between two lobes of the same region
        # and encloses retina the map never responded to.
        comp = (labels == i).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)
        eps = REGION_SIMPLIFY_FRAC * cv2.arcLength(c, True)
        poly = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(np.float32)
        if len(poly) < 3:
            continue
        found.append({"x": x, "y": y, "w": bw, "h": bh, "peak": peak,
                      "area": area, "poly": poly})

    if not found:
        return []
    found.sort(key=lambda r: (r["peak"], r["area"]), reverse=True)
    found = found[:max_regions]

    # Map from the cam's grid to the crop, then to the original photograph.
    W, H = size
    if box is None:
        sx, sy, ox, oy = W / w, H / h, 0, 0
    else:
        y0, y1, x0, x1 = box
        sx, sy, ox, oy = (x1 - x0) / w, (y1 - y0) / h, x0, y0

    out = []
    for r in found:
        x = r["x"] * sx + ox
        y = r["y"] * sy + oy
        bw = r["w"] * sx
        bh = r["h"] * sy
        px, py = bw * pad_frac, bh * pad_frac
        x, y = x - px, y - py
        bw, bh = bw + 2 * px, bh + 2 * py
        # Clamp to the photograph.
        x, y = max(0.0, x), max(0.0, y)
        bw, bh = min(bw, W - x), min(bh, H - y)
        # The outline, mapped through the same crop transform as the box. It
        # is already grown by the dilation above, so it is not scaled again -
        # scaling a polygon from its centroid stretches long thin shapes.
        poly = r["poly"].copy()
        poly[:, 0] = np.clip(poly[:, 0] * sx + ox, 0, W)
        poly[:, 1] = np.clip(poly[:, 1] * sy + oy, 0, H)

        out.append({
            "x": round(x, 1), "y": round(y, 1),
            "w": round(bw, 1), "h": round(bh, 1),
            "score": round(r["peak"], 4),
            "polygon": [[round(float(a), 1), round(float(b), 1)] for a, b in poly],
        })
    # Numbered by strength, so a clinician can talk about "box 2" and the
    # stored row means the same thing later.
    for rank, region in enumerate(out, 1):
        region["rank"] = rank
    return out
