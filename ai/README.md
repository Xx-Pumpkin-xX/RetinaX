# Grading service

FastAPI in front of the DR grading model. Two endpoints:

| | |
|---|---|
| `GET /health` | `{"ok":true,"model_loaded":bool}` — `model_loaded:false` means the stand-in is running, not the real weights |
| `POST /infer` | multipart field `file` → `{"grade":0-4,"heatmap_png_base64":str\|null}` |

**The regression score and the Nelder-Mead thresholds never leave this service.**
That is the reason it is a separate process rather than code inside the API: the
grade and the heatmap are the whole contract.

## Running it on the DGX Spark

```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
pip install -r requirements.txt        # does NOT touch torch, on purpose
./run-on-dgx.sh                        # service + public tunnel, inside tmux
```

`run-on-dgx.sh` prints the public URL. Paste it into `AI_URL` on Render, with no
trailing slash. `./run-on-dgx.sh url` prints it again; `./run-on-dgx.sh stop`
stops both.

Quick-tunnel URLs change on every restart, so re-check after any reboot.

**Do not `pip install torch` here.** The Spark is arm64 with a Grace Blackwell
GPU; the default PyPI wheel is the wrong build and will install alongside the
working one. Use the PyTorch the machine already has, or NVIDIA's container.

## Wiring in the real model

`main.py` runs a stand-in so the whole stack works before the weights are in
place. Put `model.pth` next to it and fill in the two marked blocks:

```python
def load_model():   # torch.load the .pth, .eval(), return it
def predict(img):   # your transform, forward pass, CAM / CCEM
```

Then replace `THRESHOLDS = [0.57, 1.48, 2.51, 3.42]` with your Nelder-Mead cut
points. `GET /health` reporting `model_loaded: true` is how you know the real
weights are live.

If the model is large, load it **once at import**, not per request — a reload on
every upload will make the demo look broken.
