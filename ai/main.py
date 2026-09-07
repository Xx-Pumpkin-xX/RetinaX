"""
RetinaX grading service.

Contract with the Node API (the only thing that calls this):
    POST /infer   multipart field "file"
    ->  { "grade": 0..4, "heatmap_png_base64": "<png>" | null }

The regression output and the Nelder-Mead thresholds stay in here.
Nothing else is exposed: no score, no confidence.

Run:  uvicorn main:app --port 8000 --reload
"""
import base64
import io
import os

import numpy as np
from fastapi import FastAPI, File, UploadFile
from PIL import Image

app = FastAPI(title="RetinaX grading service")

# Nelder-Mead optimised thresholds. Replace with the values from your run.
THRESHOLDS = [0.57, 1.48, 2.51, 3.42]
MODEL_PATH = os.environ.get("MODEL_PATH", "model.pth")
IMAGE_SIZE = 512

_model = None


def load_model():
    """
    TODO — plug your trained model in here.

        import torch
        from your_arch import DRNet            # the class the .pth was saved from
        m = DRNet()
        m.load_state_dict(torch.load(MODEL_PATH, map_location="cpu"))
        m.eval()
        return m

    Returning None keeps the whole pipeline runnable before the model is wired,
    so the web team is never blocked on the ML side.
    """
    return None


def score_to_grade(score: float) -> int:
    grade = 0
    for t in THRESHOLDS:
        if score >= t:
            grade += 1
    return grade


def predict(img: Image.Image):
    """Returns (grade, heatmap_as_HxW_float_array_in_0_1)."""
    global _model
    if _model is None:
        _model = load_model()

    if _model is None:
        # ---- stand-in so the app runs end to end today -------------------
        a = np.asarray(img.convert("L").resize((64, 64)), dtype=np.float32) / 255.0
        score = float(np.clip(a.std() * 14.0, 0.0, 4.0))
        yy, xx = np.mgrid[0:IMAGE_SIZE, 0:IMAGE_SIZE]
        cy, cx = IMAGE_SIZE * 0.55, IMAGE_SIZE * 0.45
        cam = np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * (IMAGE_SIZE * 0.16) ** 2)))
        return score_to_grade(score), cam

    # ---- real path ------------------------------------------------------
    # import torch
    # x = preprocess(img).unsqueeze(0)
    # with torch.no_grad():
    #     score = float(_model(x).squeeze())
    # cam = compute_ccem(_model, x)          # HxW, already normalised to 0..1
    # return score_to_grade(score), cam
    raise NotImplementedError("wire the model in predict()")


def cam_to_png(cam: np.ndarray, size) -> str:
    """Turn a 0..1 activation map into a transparent RGBA overlay PNG."""
    cam = np.clip(cam, 0.0, 1.0)
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
    return {"ok": True, "model_loaded": _model is not None}


@app.post("/infer")
async def infer(file: UploadFile = File(...)):
    img = Image.open(io.BytesIO(await file.read())).convert("RGB")
    grade, cam = predict(img)
    return {"grade": int(grade), "heatmap_png_base64": cam_to_png(cam, img.size)}
