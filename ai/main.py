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
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Query, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image


@asynccontextmanager
async def lifespan(app):
    """Load the model when the service starts, not on the first upload.

    Two reasons. A wiring mistake should appear in the startup log while you
    are watching it, rather than as a failed upload minutes later. And loading
    a 249 MB B7 checkpoint takes real time — paying that on the first request
    would make the demo's first case look broken.

    Never fatal: if the research model cannot be loaded the stand-in serves
    instead, so the API always has something to talk to.
    """
    global _model, _thresholds
    _thresholds = load_thresholds()
    try:
        _model = load_model()
    except Exception as e:
        print(f"[startup] model load failed: {type(e).__name__}: {e}")
        _model = None
    print(f"[startup] ready — {'REAL MODEL' if _model else 'STAND-IN'} | "
          f"thresholds {_thresholds}", flush=True)
    yield


app = FastAPI(title="RetinaX grading service", lifespan=lifespan)

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
    """Load the real model through the adapter, or fall back to the stand-in.

    Set DR_REPO and MODEL_PATH and this picks up ProjectDR2026. With neither
    set — or if the import fails — it returns None and the stand-in keeps the
    whole app runnable, so the web side is never blocked on the ML side.
    """
    if not os.environ.get("DR_REPO"):
        print("[model] DR_REPO not set — running the stand-in")
        return None
    try:
        import dr_adapter
        return dr_adapter.load_model()
    except Exception as e:
        print(f"[model] could not load the research model: {type(e).__name__}: {e}")
        print("[model] falling back to the stand-in so the service still answers")
        return None


def score_to_grade(score: float) -> int:
    return int(sum(1 for t in _thresholds if score >= t))





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
    import dr_adapter
    x, rgb = dr_adapter.preprocess(img)
    grade = dr_adapter.score_to_grade(dr_adapter.predict_score(x))

    # Grad-CAM++ is one backward pass, so it always runs. CCEM is three
    # explainers and hundreds of passes, so it runs only when asked for.
    cam = dr_adapter.explain_gradcampp(x)
    ccem = dr_adapter.explain_ccem(x, rgb) if want_ccem else None
    return grade, cam, ccem


# Below this the map is treated as background and drawn fully transparent.
# Without a floor, a weak activation across the whole retina is painted as a
# faint wash, and the photograph underneath — the thing the doctor is actually
# reading — is veiled everywhere at once.
HEATMAP_FLOOR = float(os.environ.get("HEATMAP_FLOOR", 0.35))
HEATMAP_MAX_ALPHA = float(os.environ.get("HEATMAP_MAX_ALPHA", 0.85))


def cam_to_png(cam, size) -> str | None:
    """Turn a 0..1 activation map into a transparent RGBA overlay PNG.

    Cyan through violet to magenta, not the usual red-yellow heat ramp.
    A fundus photograph is orange: a warm overlay on a warm image is the one
    colour choice guaranteed to be hard to read, and worse for the roughly
    1 in 12 men with a red-green deficiency. Blue-magenta is the complement of
    retinal orange, so the activation separates from the tissue instead of
    blending into it.
    """
    if cam is None:
        return None
    cam = np.clip(np.asarray(cam, dtype=np.float32), 0.0, 1.0)

    # Rescale so the floor becomes 0 and the peak stays 1 — the ramp then
    # spends its whole range on activation that means something.
    t = np.clip((cam - HEATMAP_FLOOR) / max(1e-6, 1.0 - HEATMAP_FLOOR), 0.0, 1.0)

    r = t ** 1.5                              # arrives late: only the hottest goes magenta
    g = np.clip(1.35 * (1.0 - t) - 0.15, 0, 1)  # cyan at the low end, gone by the middle
    b = np.clip(0.55 + 0.45 * t, 0, 1)          # blue throughout, so nothing reads as warm
    alpha = (t ** 0.85) * HEATMAP_MAX_ALPHA

    rgba = (np.dstack([r, g, b, alpha]) * 255).astype(np.uint8)
    out = Image.fromarray(rgba, mode="RGBA").resize(size, Image.BILINEAR)
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


@app.get("/health")
def health():
    out = {
        "ok": True,
        "model_loaded": _model is not None,
        "ccem_on_upload": CCEM_ON_UPLOAD,
    }
    try:
        import dr_adapter
        out.update(dr_adapter.health())
    except Exception:
        out["image_size"] = IMAGE_SIZE
    # Report the thresholds actually in use. The adapter keeps its own copy and
    # never loads it when the stand-in is running, which would show null here
    # while the service was happily grading with the fallback values.
    out["thresholds"] = _thresholds
    out["note"] = None if _model else "stand-in model — grades are not real"
    return out


@app.post("/infer")
async def infer(
    file: UploadFile = File(...),
    ccem: bool = Query(default=None, description="override CCEM_ON_UPLOAD for this request"),
):
    want_ccem = CCEM_ON_UPLOAD if ccem is None else ccem
    img = Image.open(io.BytesIO(await file.read())).convert("RGB")
    try:
        grade, cam, ccem_map = predict(img, want_ccem)
    except Exception as e:
        # Say what actually broke in the response body. A bare "Internal Server
        # Error" means going to find the server's terminal and scrolling, which
        # is slow while the wiring is still being shaken out. This is a research
        # service on a private network, not a public API — the traceback is not
        # leaking anything an attacker could use.
        tb = traceback.format_exc()
        print(tb, flush=True)
        return JSONResponse(
            status_code=500,
            content={
                "error": f"{type(e).__name__}: {e}",
                "where": "predict()",
                "traceback": tb.splitlines()[-12:],
            },
        )
    return {
        "grade": int(grade),
        "heatmap_cam_png_base64": cam_to_png(cam, img.size),
        "heatmap_ccem_png_base64": cam_to_png(ccem_map, img.size),
    }
