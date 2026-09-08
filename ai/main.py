"""
RetinaX grading service.

Contract with the Node API (the only thing that calls this):

    POST /infer   multipart field "file"
    ->  {
          "grade": 0..4,
          "heatmap_cam_png_base64":  "<png>" | null,   # Grad-CAM++
          "heatmap_ccem_png_base64": "<png>" | null    # CCEM fusion
        }

Two maps, not one, because the case screen offers Default / CAM / CCEM and those
must be three different pictures. Grad-CAM++ is a single backward pass and is
cheap enough to compute on upload. CCEM fuses Grad-CAM++, Ada-SISE and SmoothIG,
which is hundreds of passes — it may legitimately come back null on a live
upload and be filled in later by a batch run.

The regression output and the Nelder-Mead thresholds stay in here. Nothing else
is exposed: no score, no confidence.

Run:  uvicorn main:app --host 0.0.0.0 --port 8000
"""
import base64
import io
import os

import numpy as np
from fastapi import FastAPI, File, Query, UploadFile
from PIL import Image

app = FastAPI(title="RetinaX grading service")

# --------------------------------------------------------------------- config
# B7 was trained at 600; the research runs use --img_size 600.
IMAGE_SIZE = int(os.environ.get("IMAGE_SIZE", 600))
MODEL_PATH = os.environ.get("MODEL_PATH", "model.pth")
# The research repo saves Nelder-Mead cut points as best_thresholds.npy and
# passes them with --threshold_path. Loading the file beats copying four
# numbers by hand and letting them drift from the checkpoint they belong to.
THRESHOLD_PATH = os.environ.get("THRESHOLD_PATH", "best_thresholds.npy")
FALLBACK_THRESHOLDS = [0.57, 1.48, 2.51, 3.42]

# Full CCEM on an upload is minutes, not seconds. Off by default: the API's
# timeout is 45s, and a request that always times out is worse than one that
# honestly returns Grad-CAM++ only.
CCEM_ON_UPLOAD = os.environ.get("CCEM_ON_UPLOAD", "0") == "1"

_model = None
_thresholds = None


def load_thresholds():
    """Nelder-Mead cut points that turn the regression output into a grade."""
    try:
        t = np.load(THRESHOLD_PATH).astype(float).ravel().tolist()
        if len(t) == 4:
            print(f"[thresholds] loaded {THRESHOLD_PATH}: {t}")
            return t
        print(f"[thresholds] {THRESHOLD_PATH} has {len(t)} values, expected 4 — ignoring")
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[thresholds] could not read {THRESHOLD_PATH}: {e}")
    print(f"[thresholds] using fallback {FALLBACK_THRESHOLDS} — REPLACE BEFORE ANY REAL USE")
    return list(FALLBACK_THRESHOLDS)


def load_model():
    """
    TODO — plug the trained model in here.

    The research repo builds EfficientNet-B7 with an optional CBAM block and a
    regression head, trained in three stages. Import its builder rather than
    redefining the architecture, so the two can never drift apart:

        import sys, torch
        sys.path.insert(0, os.environ["DR_REPO"])          # the research repo
        from src.training.model import build_model          # adjust to the real name

        m = build_model(model="B7", use_cbam=True)
        state = torch.load(MODEL_PATH, map_location="cpu")
        m.load_state_dict(state.get("state_dict", state))
        return m.eval().to("cuda" if torch.cuda.is_available() else "cpu")

    Returning None keeps the whole pipeline runnable before the model is wired,
    so the web side is never blocked on the ML side.
    """
    return None


def score_to_grade(score: float) -> int:
    return int(sum(1 for t in _thresholds if score >= t))


def explain_cam(x):
    """
    TODO — Grad-CAM++ for one image. One forward and one backward pass; fast
    enough to run on upload.

        from src.xai.explanation.gradcampp import gradcampp   # adjust to the real name
        return gradcampp(_model, x)      # HxW float array in 0..1
    """
    raise NotImplementedError


def explain_ccem(x):
    """
    TODO — CCEM for one image.

    The research pipeline is file-based: each explainer writes .npy maps into
    an --xai_dir, and run_maples_ccem.py fuses whatever it finds there. That
    shape is right for evaluating a dataset and wrong for serving one image, so
    this needs a single-image path that calls the three explainers in memory and
    hands their maps to the fusion function directly.

    The fusion itself is cheap — resize, robust normalisation, reliability
    weighting, blur. The cost is the three explainers, and SmoothIG dominates:
    n_steps x nt_samples forward+backward passes. Batch those samples rather
    than looping; it is roughly a tenfold difference.
    """
    raise NotImplementedError


def _standin(img: Image.Image):
    """Runs before the weights are wired, so the app works end to end.

    The two maps are deliberately different shapes — if CAM and CCEM looked
    identical here, nobody would notice when they were identical for real."""
    a = np.asarray(img.convert("L").resize((64, 64)), dtype=np.float32) / 255.0
    score = float(np.clip(a.std() * 14.0, 0.0, 4.0))

    yy, xx = np.mgrid[0:IMAGE_SIZE, 0:IMAGE_SIZE]

    def blob(cx, cy, r):
        return np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r ** 2)))

    # CAM: one broad region, the way a class activation map usually looks.
    cam = blob(IMAGE_SIZE * 0.45, IMAGE_SIZE * 0.55, IMAGE_SIZE * 0.17)

    # CCEM: tighter and multi-focal, the way a consensus map usually looks.
    ccem = np.maximum.reduce([
        blob(IMAGE_SIZE * 0.42, IMAGE_SIZE * 0.52, IMAGE_SIZE * 0.075),
        blob(IMAGE_SIZE * 0.63, IMAGE_SIZE * 0.38, IMAGE_SIZE * 0.055) * 0.85,
        blob(IMAGE_SIZE * 0.30, IMAGE_SIZE * 0.70, IMAGE_SIZE * 0.05) * 0.7,
    ])
    return score_to_grade(score), cam, ccem


def predict(img: Image.Image, want_ccem: bool):
    """Returns (grade, cam_or_None, ccem_or_None), each HxW float in 0..1."""
    global _model, _thresholds
    if _thresholds is None:
        _thresholds = load_thresholds()
    if _model is None:
        _model = load_model()

    if _model is None:
        grade, cam, ccem = _standin(img)
        return grade, cam, (ccem if want_ccem else None)

    # ---- real path ------------------------------------------------------
    # import torch
    # x = preprocess(img).unsqueeze(0).to(next(_model.parameters()).device)
    # with torch.no_grad():
    #     score = float(_model(x).squeeze())
    # cam  = explain_cam(x)
    # ccem = explain_ccem(x) if want_ccem else None
    # return score_to_grade(score), cam, ccem
    raise NotImplementedError("wire the model in predict()")


def cam_to_png(cam, size) -> str | None:
    """Turn a 0..1 activation map into a transparent RGBA overlay PNG."""
    if cam is None:
        return None
    cam = np.clip(np.asarray(cam, dtype=np.float32), 0.0, 1.0)
    r = np.clip(1.6 * cam - 0.2, 0, 1)
    g = np.clip(1.4 * cam - 0.5, 0, 1)
    b = np.clip(0.5 - 1.5 * cam, 0, 1)
    alpha = np.clip(cam * 1.15, 0, 1)
    rgba = (np.dstack([r, g, b, alpha]) * 255).astype(np.uint8)
    out = Image.fromarray(rgba, mode="RGBA").resize(size, Image.BILINEAR)
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


@app.get("/health")
def health():
    return {
        "ok": True,
        "model_loaded": _model is not None,
        "thresholds_loaded": _thresholds is not None and _thresholds != FALLBACK_THRESHOLDS,
        "ccem_on_upload": CCEM_ON_UPLOAD,
        "image_size": IMAGE_SIZE,
    }


@app.post("/infer")
async def infer(
    file: UploadFile = File(...),
    ccem: bool = Query(default=None, description="override CCEM_ON_UPLOAD for this request"),
):
    want_ccem = CCEM_ON_UPLOAD if ccem is None else ccem
    img = Image.open(io.BytesIO(await file.read())).convert("RGB")
    grade, cam, ccem_map = predict(img, want_ccem)
    return {
        "grade": int(grade),
        "heatmap_cam_png_base64": cam_to_png(cam, img.size),
        "heatmap_ccem_png_base64": cam_to_png(ccem_map, img.size),
    }
