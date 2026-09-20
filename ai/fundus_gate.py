import os

import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor


MODEL_NAME = os.environ.get(
    "FUNDUS_CLIP_MODEL",
    "openai/clip-vit-base-patch32",
)

ACCEPT_THRESHOLD = float(
    os.environ.get("FUNDUS_ACCEPT_THRESHOLD", "0.70")
)

REJECT_THRESHOLD = float(
    os.environ.get("FUNDUS_REJECT_THRESHOLD", "0.30")
)


POSITIVE_PROMPTS = [
    "a color fundus photograph of the human retina",
    "a retinal fundus photograph",
    "an ophthalmic fundus photograph",
    "a photograph of the retina",
    "a retinal image showing the optic disc and blood vessels",
    "a medical color photograph of the inside of the eye",
]


NEGATIVE_PROMPTS = [
    "a normal photograph of an object",
    "a photograph of a person or animal",
    "an illustration or anime image",
    "a screenshot or computer graphic",
    "a photograph of the outside of a human eye",
    "an image that is not a retinal fundus photograph",
]


PROMPTS = POSITIVE_PROMPTS + NEGATIVE_PROMPTS


_model = None
_processor = None
_device = None


def load():
    global _model, _processor, _device

    if _model is not None:
        return

    _device = "cuda" if torch.cuda.is_available() else "cpu"

    print(
        f"[fundus-gate] loading {MODEL_NAME} on {_device}",
        flush=True,
    )

    _model = CLIPModel.from_pretrained(
        MODEL_NAME
    ).to(_device)

    _processor = CLIPProcessor.from_pretrained(
        MODEL_NAME
    )

    _model.eval()

    print(
        f"[fundus-gate] ready | "
        f"accept>={ACCEPT_THRESHOLD:.2f} "
        f"reject<={REJECT_THRESHOLD:.2f}",
        flush=True,
    )


@torch.no_grad()
def classify(image: Image.Image):
    if _model is None:
        load()

    image = image.convert("RGB")

    inputs = _processor(
        text=PROMPTS,
        images=image,
        return_tensors="pt",
        padding=True,
    )

    inputs = {
        k: v.to(_device)
        for k, v in inputs.items()
    }

    outputs = _model(**inputs)
    logits = outputs.logits_per_image[0]

    n_pos = len(POSITIVE_PROMPTS)

    pos_logit = logits[:n_pos].mean()
    neg_logit = logits[n_pos:].mean()

    probs = torch.softmax(
        torch.stack([neg_logit, pos_logit]),
        dim=0,
    )

    non_fundus_score = float(probs[0].item())
    fundus_score = float(probs[1].item())

    if fundus_score >= ACCEPT_THRESHOLD:
        status = "fundus"

    elif fundus_score <= REJECT_THRESHOLD:
        status = "not_fundus"

    else:
        status = "uncertain"

    return {
        "status": status,
        "fundus_score": fundus_score,
        "non_fundus_score": non_fundus_score,
    }


def health():
    return {
        "fundus_gate_loaded": _model is not None,
        "fundus_gate_model": MODEL_NAME,
        "fundus_accept_threshold": ACCEPT_THRESHOLD,
        "fundus_reject_threshold": REJECT_THRESHOLD,
    }
