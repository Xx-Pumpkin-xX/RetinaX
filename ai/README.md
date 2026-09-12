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

**Through JupyterLab:** upload this folder and open `run_on_dgx.ipynb`. Run the
cells top to bottom — it checks PyTorch without disturbing it, installs only the
web-service packages, starts the service detached from the kernel so a restart
does not kill it, and prints the URL to put in `AI_URL`.

**Through SSH:**

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

## How long does it take on this machine?

```bash
python benchmark.py                 # torchvision B7, no weights needed
python benchmark.py --pth model.pth --half
```

Prints the cost of one grading, one Grad-CAM++, and the per-sample cost at
several batch sizes — then extrapolates what your CCEM settings would cost per
image. Pass `--ig-steps`, `--sg-samples` and `--sise-passes` to match your real
configuration.

The batching rows are the important ones. Integrated Gradients and SmoothGrad
are hundreds of independent passes; running them one at a time instead of
batched is the difference between a minute and ten.

## Wiring in the real model — done

`dr_adapter.py` bridges to **ProjectDR2026**. Three environment variables and it
picks up the real model; leave them unset and the stand-in runs instead, so the
web side is never blocked.

```bash
export DR_REPO=$HOME/Projects/USTH/ProjectDR2026
export MODEL_PATH=$DR_REPO/src/experiments/Stage2_Finetune_B7_CBAM/stage2_best_model.pth
export THRESHOLD_PATH=$DR_REPO/src/experiments/Stage2_Finetune_B7_CBAM/best_thresholds.npy
pip install albumentations opencv-python timm grad-cam captum   # NOT torch
uvicorn main:app --host 0.0.0.0 --port 8000
```

`GET /health` reports `model_loaded`, the device, and the thresholds it read.

### The Spark is shared

Another user's training run can take almost all of the 128 GB of unified memory
and leave nothing for inference — this has already happened once, with 111 GB
gone and the service dead.

So an out-of-memory error no longer kills a request. The model moves to the CPU
and the request is retried; B7 on the Grace cores is seconds rather than
milliseconds, which is slow but is not a broken demo. It stays on the CPU for the
life of the process instead of thrashing back each request. `/health` reports
`on_cpu_fallback: true` when that has happened, so "why is this slow today" has
an immediate answer.

`FORCE_CPU=1` starts on the CPU deliberately — worth doing if you know someone
is training during your slot.

The other half of the insurance is `server/demo-images/precomputed/`: the seeded
demo cases carry committed grades and heatmaps, so the deployed app is fully
populated even with the Spark completely unavailable.

### What it reproduces, and why exactly

| | Taken from |
|---|---|
| `tf_efficientnet_b7_ns`, `num_classes=1`, CBAM on | `train_stage2.py:189`, `model.py` |
| 600 x 600 | `EFF_SIZES['B7']` in `train_stage2.py:21` |
| `crop_image_from_gray` -> `apply_clahe` -> Resize -> ImageNet Normalize | `APTOSDataset.__getitem__` + `get_valid_transforms` |
| grade = how many cut points the score passed | `OptimizedRounder.predict` in `rounder.py` |
| three-view TTA, averaged | `validate_with_tta` in `train_stage2.py` |

**The crop and the CLAHE are not optional.** Skip them and the model still
returns a number, the app still shows a grade, and it is wrong — nothing in the
UI looks broken. They are imported from the repo rather than reimplemented so
they cannot drift.

**TTA is on by default** (`USE_TTA=0` to disable). Validation averaged three
views — original, h-flip, v-flip — and `best_thresholds.npy` was fitted on those
averaged scores. Serving a single pass shifts the score distribution slightly
and quietly mis-calibrates every cut point. Three forward passes is a cheap
price for the thresholds meaning what they say.

**`augmentation.py` in the research repo does not parse** — there is a stray
`integrity` token on line 5, inside `get_train_transforms`, and the same
corruption is in its `.ipynb_checkpoints` copy. Any `import augmentation` raises
`IndentationError`, so re-running training will fail until it is fixed. The
adapter sidesteps it by rebuilding the three-line validation transform inline
rather than importing the module.

## Older notes on wiring

First, describe the research repo:

```bash
python inspect_repo.py ~/DR_project \
       --pth checkpoints/best.pth --thresholds best_thresholds.npy
```

Writes `retinax-repo-inspect.txt` (use `--out` to change it) and prints five
lines to the terminal. It reads the source with `ast` rather than importing it —
nothing runs and no CUDA is touched.

The file is ordered by what a wrapper needs: checkpoint shape, thresholds,
**preprocessing**, then the model builders, the explainers and the CCEM fusion.
`Archive/`, `__pycache__/` and test folders are skipped, and repeated
preprocessing lines are shown once rather than in every runner that copies them.

Preprocessing comes near the top on purpose. A transform that differs from the
one used in training still returns a number, and the app still shows a grade —
it is the only mismatch on that list that fails silently.


`main.py` runs a stand-in so the whole stack works before the weights are in
place. Put `model.pth` next to it and fill in the two marked blocks:

```python
def load_model():   # torch.load the .pth, .eval(), return it
def predict(img):   # your transform, forward pass, CAM / CCEM
```

Then replace `THRESHOLDS = [0.57, 1.48, 2.51, 3.42]` with your Nelder-Mead cut
points. `GET /health` reporting `model_loaded: true` is how you know the real
weights are live.
