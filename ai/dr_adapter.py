"""
Bridge between the RetinaX service and the ProjectDR2026 research repo.

Everything that knows about the research code lives here; main.py only knows
the HTTP contract. Set one environment variable and it wires itself:

    DR_REPO=/home/hungntt/Projects/USTH/ProjectDR2026
    MODEL_PATH=$DR_REPO/src/experiments/Stage2_Finetune_B7_CBAM/stage2_best_model.pth
    THRESHOLD_PATH=$DR_REPO/src/experiments/Stage2_Finetune_B7_CBAM/best_thresholds.npy

The preprocessing below is copied from the training dataset rather than
imported, and that is deliberate — see PREPROCESSING below.
"""
import os
import sys
import pathlib

import numpy as np

DR_REPO = os.environ.get("DR_REPO", "")
MODEL_PATH = os.environ.get("MODEL_PATH", "model.pth")
THRESHOLD_PATH = os.environ.get("THRESHOLD_PATH", "best_thresholds.npy")

# EFF_SIZES['B7'] in train_stage2.py. B7 was trained at 600; changing this
# changes the answers.
IMAGE_SIZE = int(os.environ.get("IMAGE_SIZE", 600))
MODEL_NAME = os.environ.get("MODEL_NAME", "tf_efficientnet_b7_ns")
USE_CBAM = os.environ.get("USE_CBAM", "1") == "1"

# Validation in train_stage2.py averages three passes — original, h-flip,
# v-flip — and best_thresholds.npy was fitted on those averaged scores. Serving
# a single pass would shift the score distribution slightly and quietly
# mis-calibrate every threshold, so the default matches training.
USE_TTA = os.environ.get("USE_TTA", "1") == "1"

# The Spark is shared. Another user's training run can take most of the 128 GB
# of unified memory and leave nothing for inference. Rather than dying, fall
# back to the CPU: B7 on the Grace cores is seconds rather than milliseconds,
# which is slow but is not "the demo is broken".
FORCE_CPU = os.environ.get("FORCE_CPU", "0") == "1"


def _add_repo_to_path():
    """The research modules import each other flat (`from model import ...`),
    so their directories go on sys.path, not just the repo root."""
    if not DR_REPO:
        raise RuntimeError("DR_REPO is not set — cannot find the research code")
    root = pathlib.Path(DR_REPO).expanduser().resolve()
    for sub in ("src/training", "src/xai/explanation", "src/xai/explanation/explainer",
                "src/xai/CCEM", "src/xai"):
        p = root / sub
        if p.is_dir() and str(p) not in sys.path:
            sys.path.insert(0, str(p))
    return root


# ----------------------------------------------------------- PREPROCESSING --
# Reproduced from APTOSDataset.__getitem__ + get_valid_transforms in
# train_stage2.py:
#
#     image = cv2.imread(path)
#     image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
#     image = crop_image_from_gray(image)
#     image = apply_clahe(image)
#     A.Resize(600, 600) -> A.Normalize(ImageNet) -> ToTensorV2()
#
# The crop and the CLAHE are the part that is easy to miss: skip them and the
# model still returns a number, the app still shows a grade, and it is wrong.
# Nothing in the UI would look broken.
#
# `crop_image_from_gray` and `apply_clahe` are imported from the repo so they
# cannot drift. The transform is rebuilt here instead of imported because
# augmentation.py does not parse — there is a stray token on line 5 of
# get_train_transforms. Importing it would raise IndentationError, and the
# valid transform is three lines.

def build_transform():
    import albumentations as A
    from albumentations.pytorch import ToTensorV2
    return A.Compose([
        A.Resize(height=IMAGE_SIZE, width=IMAGE_SIZE),
        A.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ToTensorV2(),
    ])


def gray_crop_box(rgb, tol=7):
    """Where crop_image_from_gray cuts, in the ORIGINAL image's coordinates.

    The repo's function returns the cropped array and not where it came from,
    which is fine for training and wrong for us: an explanation map is computed
    on the cropped retina and then has to be drawn back onto the photograph the
    doctor is looking at. Without the offset the map is stretched across the
    full frame, so every hotspot drifts outwards — visibly, off the retina and
    into the black border.

    Same rule as the repo's: keep the bounding box of everything brighter than
    `tol` in grayscale.
    """
    import cv2
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    mask = gray > tol
    if not mask.any():
        return (0, rgb.shape[0], 0, rgb.shape[1])
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    return (int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1)


def preprocess(pil_image):
    """PIL RGB -> (1,3,H,W) tensor, the RGB uint8 array CCEM needs, and the box
    that array occupies in the original photograph."""
    import cv2  # noqa: F401  (imported by the repo's preprocessing module too)
    from preprocessing import crop_image_from_gray, apply_clahe

    full = np.asarray(pil_image.convert("RGB"))   # already RGB, so no BGR swap
    rgb = crop_image_from_gray(full)

    # Locate the crop rather than assume it. If our box does not reproduce the
    # repo's crop exactly, fall back to the whole frame: a slightly misplaced
    # overlay is a defect, but a confidently misplaced one is a lie.
    box = gray_crop_box(full)
    if rgb.shape[:2] != (box[1] - box[0], box[3] - box[2]):
        print(f"[crop] box {box} does not match crop {rgb.shape[:2]} — "
              f"placing the overlay over the full frame", flush=True)
        box = (0, full.shape[0], 0, full.shape[1])

    rgb = apply_clahe(rgb)

    x = build_transform()(image=rgb)["image"].unsqueeze(0)
    return x, rgb, box


# ------------------------------------------------------------------ MODEL --
_model = None
_device = None
_thresholds = None
_thresholds_fitted = None   # True = from best_thresholds.npy, False = the fallback


def load_thresholds():
    """Nelder-Mead cut points from OptimizedRounder.fit().

    These are NOT in the checkpoint. The model is a regression head returning a
    single continuous score; these four cut points turn that score into a grade,
    and they were fitted separately after training. Falling back to the starting
    guess [0.5, 1.5, 2.5, 3.5] does not break anything visibly — it just moves
    every boundary, most damagingly 3.042 -> 3.5, which is the severe-NPDR/PDR
    referral decision. So the fallback is reported in /health, not just logged.
    """
    global _thresholds, _thresholds_fitted
    if _thresholds is not None:
        return _thresholds
    try:
        t = np.load(THRESHOLD_PATH).astype(float).ravel().tolist()
        if len(t) == 4:
            _thresholds = t
            _thresholds_fitted = True
            print(f"[thresholds] {THRESHOLD_PATH}: {t}")
            return t
        print(f"[thresholds] {THRESHOLD_PATH} has {len(t)} values, expected 4")
    except FileNotFoundError:
        print(f"[thresholds] {THRESHOLD_PATH} not found")
    except Exception as e:
        print(f"[thresholds] could not read {THRESHOLD_PATH}: {e}")
    _thresholds = [0.5, 1.5, 2.5, 3.5]      # OptimizedRounder's initial_coef
    _thresholds_fitted = False
    print(f"[thresholds] !! falling back to {_thresholds} — these are the UNFITTED "
          f"starting values. Every grade will be miscalibrated. Set THRESHOLD_PATH.")
    return _thresholds


def load_model():
    """APTOSModel from the research repo, with the stage-2 weights."""
    global _model, _device
    if _model is not None:
        return _model

    _add_repo_to_path()
    import torch
    from model import APTOSModel

    _device = torch.device("cpu" if FORCE_CPU or not torch.cuda.is_available() else "cuda")
    # pretrained=False: the weights come from the checkpoint, and downloading
    # ImageNet weights first would be a slow no-op on a machine with no egress.
    m = APTOSModel(model_name=MODEL_NAME, num_classes=1,
                   pretrained=False, use_cbam=USE_CBAM)

    obj = torch.load(MODEL_PATH, map_location="cpu", weights_only=False)
    if isinstance(obj, dict):
        state = obj.get("state_dict", obj.get("model_state_dict", obj))
        # Saved from DataParallel? Strip the prefix rather than failing.
        if any(k.startswith("module.") for k in state):
            state = {k[len("module."):]: v for k, v in state.items()}
        missing, unexpected = m.load_state_dict(state, strict=False)
        if missing or unexpected:
            print(f"[model] missing={len(missing)} unexpected={len(unexpected)}")
            if len(missing) > 20:
                print("[model] !! that is a lot — check MODEL_NAME and USE_CBAM match "
                      "the checkpoint (tf_efficientnet_b7_ns, CBAM on)")
    else:
        m = obj      # a pickled nn.Module

    _model = m.eval().to(_device)
    load_thresholds()
    print(f"[model] {MODEL_NAME} | cbam={USE_CBAM} | {IMAGE_SIZE}px | {_device} | tta={USE_TTA}")
    return _model


def _is_oom(e):
    """torch is imported lazily throughout this module, so import it here too —
    a NameError on the recovery path would defeat the whole point."""
    try:
        import torch
        oom_cls = getattr(torch.cuda, "OutOfMemoryError", None)
        if oom_cls is not None and isinstance(e, oom_cls):
            return True
    except ImportError:
        pass
    # Older torch, and the CPU allocator, only say it in the message.
    return "out of memory" in str(e).lower() or "cuda error" in str(e).lower()


def run_resilient(fn, *args, **kwargs):
    """Run something on the GPU; on out-of-memory, move to CPU and retry once.

    A shared machine means the GPU can vanish underneath a running service.
    Answering slowly beats answering with a 500 during a demo — and once the
    model has moved to the CPU it stays there for the life of the process
    rather than thrashing back and forth on every request.
    """
    global _device
    import torch
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        if not _is_oom(e) or _device.type == "cpu":
            raise
        print(f"[gpu] out of memory — moving the model to CPU and retrying. ({e})", flush=True)
        torch.cuda.empty_cache()
        _device = torch.device("cpu")
        _model.to(_device)
        torch.cuda.empty_cache()
        return fn(*args, **kwargs)


def score_to_grade(score):
    """OptimizedRounder.predict: how many cut points the score has passed."""
    return int(sum(1 for t in load_thresholds() if score >= t))


def predict_score_views(x):
    """Every TTA view's raw score, unaveraged.

    The averaging used to happen here and the spread was discarded. It is the
    cheapest honest uncertainty estimate we have: grade each view separately
    and, if the original and its two flips land on different grades, the model
    is not sure — see confidence.py. So the list is returned and the caller
    averages.
    """
    import torch
    model = load_model()

    def _run():
        with torch.no_grad():
            views = [x]
            if USE_TTA:
                views += [torch.flip(x, dims=[3]), torch.flip(x, dims=[2])]  # h-flip, v-flip
            return [float(model(v.to(_device)).squeeze()) for v in views]

    return run_resilient(_run)


def predict_score(x):
    """Regression output, averaged over TTA to match how validation ran."""
    scores = predict_score_views(x)
    return sum(scores) / len(scores)


# ------------------------------------------------------------- EXPLAINERS --
def _as_map(out):
    """The explainers return an array, or a tuple whose first item is one.
    Reduce whatever comes back to a 2-D float map in 0..1."""
    import torch
    if isinstance(out, (tuple, list)):
        out = out[0]
    if isinstance(out, dict):
        for k in ("heatmap", "cam", "map", "attribution"):
            if k in out:
                out = out[k]
                break
    if isinstance(out, torch.Tensor):
        out = out.detach().cpu().numpy()
    a = np.asarray(out, dtype=np.float32)
    while a.ndim > 2:
        a = a[0] if a.shape[0] == 1 else a.mean(axis=0)
    lo, hi = float(np.nanmin(a)), float(np.nanmax(a))
    return np.zeros_like(a) if hi - lo < 1e-8 else (a - lo) / (hi - lo)


def explain_gradcampp(x):
    from gradcampp import CompactGradCAMPlusPlus
    cam = CompactGradCAMPlusPlus(load_model(), use_cbam=USE_CBAM)
    return _as_map(run_resilient(lambda: cam.generate_heatmap(x.to(_device), target_class=0)))


def explain_adasise(x):
    from adasise import AdaSISE, select_adasise_target_layers
    model = load_model()
    ada = AdaSISE(model,
                  input_size=(IMAGE_SIZE, IMAGE_SIZE),
                  target_layers=select_adasise_target_layers(model, mode="lesion"),
                  device=_device)
    return _as_map(ada.generate_heatmap(x.to(_device)))


def explain_smoothig(x, nt_samples=16):
    from smoothig import IntegratedGradientsSmoothGradXAI
    ig = IntegratedGradientsSmoothGradXAI(load_model(), device=_device,
                                          nt_samples=nt_samples)
    return _as_map(ig.generate_heatmap(x.to(_device)))


def explain_ccem(x, rgb, nt_samples=16):
    """The full fusion: three explainers, then adaptive reliability weighting.

    generate_ccem takes arrays rather than a directory of .npy files, so the
    single-image path needs no temp-file staging — the batch runners write
    .npy only because they process a dataset.
    """
    from ccem_core import generate_ccem, make_retina_mask

    G = explain_gradcampp(x)
    AdaS = explain_adasise(x)
    IG = explain_smoothig(x, nt_samples=nt_samples)

    return _as_map(generate_ccem(
        G=G, AdaS=AdaS, IG=IG,
        retina_mask=make_retina_mask(rgb),
        image=rgb,
        model=load_model(),
        image_tensor=x.to(_device),
        mode="adaptive_reliability",
    ))


def health():
    return {
        "model_loaded": _model is not None,
        "device": str(_device) if _device else None,
        "repo": DR_REPO or None,
        "model_name": MODEL_NAME,
        "use_cbam": USE_CBAM,
        "image_size": IMAGE_SIZE,
        "tta": USE_TTA,
        "thresholds": _thresholds,
        # Unambiguous on purpose: "fallback" here means the grades are wrong,
        # and nothing else in the response would tell you.
        "thresholds_source": (None if _thresholds_fitted is None
                              else "best_thresholds.npy" if _thresholds_fitted
                              else "FALLBACK — UNFITTED, GRADES MISCALIBRATED"),
        # Surfaced so a demo-day "why is this slow" has an immediate answer.
        "on_cpu_fallback": _device is not None and _device.type == "cpu"
                           and not FORCE_CPU,
    }
