"""Load the six lesion checkpoints once and run an image through them.

THE ONE THING THAT MUST NOT DRIFT
---------------------------------
The preprocessing here is copied from LesionSet in train_lesions.py on purpose:
INTER_AREA resize to the checkpoint's own `size`, /255, ImageNet mean/std, CHW.
Load a model with different normalisation and it still runs, still returns a
plausible-looking probability map, and is quietly wrong - the failure mode with
no error message. If train_lesions.py's transform ever changes, change it here
in the same commit.

WHICH IMAGE TO FEED IT
----------------------
Feed the SAME CROP the grading model sees, and pass the same `box` on to
lesion_block. Coordinates then travel: model grid -> crop -> original
photograph, exactly as cam_regions does. Feed the uncropped photograph while
passing a crop box and every mark lands in the wrong place.

    from lesion_infer import LesionModels
    from lesion_regions import lesion_block, load_metrics

    LESIONS = LesionModels("/home/hungntt/lesion-weights")      # at startup
    METRICS = load_metrics("/home/hungntt/lesion-weights")

    masks = LESIONS.predict(cropped_rgb)                        # per request
    out["lesions"] = lesion_block(masks, img.size, box, grade=grade,
                                  metrics=METRICS)

A class with no checkpoint is simply absent from the returned dict, and
lesion_block reports it as not_assessed. Partial deployment is safe.
"""

from pathlib import Path

import numpy as np

CLASSES = ["MA", "HE", "EX", "SE", "IRMA", "NV"]

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def _build(encoder):
    import segmentation_models_pytorch as smp
    # No imagenet fetch: load_state_dict overwrites every weight anyway, and on
    # a box with no route to the weight host the download is a long timeout.
    return smp.Unet(encoder_name=encoder, encoder_weights=None,
                    in_channels=3, classes=1)


class LesionModels:
    """Six specialists, held in memory. One model per class, never a shared head.

    half=True stores them in fp16: roughly 50 MB per class instead of 100, and
    the difference is invisible at this threshold. Set it False if you ever see
    a class produce all-zero maps on a GPU without fast fp16.
    """

    def __init__(self, weights_dir, device=None, half=True, classes=CLASSES):
        import torch

        self.torch = torch
        self.dir = Path(weights_dir)
        self.device = torch.device(
            device or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.half = bool(half) and self.device.type == "cuda"
        self.models, self.sizes = {}, {}

        for key in classes:
            path = self.dir / f"{key}.pth"
            if not path.exists():
                continue
            ck = torch.load(path, map_location="cpu", weights_only=False)
            model = _build(ck.get("encoder", "resnet34"))
            model.load_state_dict(ck["state_dict"])
            model.eval().to(self.device)
            if self.half:
                model.half()
            self.models[key] = model
            self.sizes[key] = int(ck.get("size", 512))

    def __repr__(self):
        loaded = ", ".join(f"{k}@{self.sizes[k]}" for k in self.models) or "none"
        return f"<LesionModels {loaded} on {self.device}>"

    @property
    def loaded(self):
        return list(self.models)

    def _tensor(self, rgb, size):
        import cv2
        img = cv2.resize(np.asarray(rgb), (size, size), interpolation=cv2.INTER_AREA)
        img = img.astype(np.float32) / 255.0
        img = (img - MEAN) / STD
        t = self.torch.from_numpy(img.transpose(2, 0, 1)[None]).to(self.device)
        return t.half() if self.half else t

    def predict(self, rgb):
        """{key: 2-D float32 probability map} for every loaded class.

        rgb is HxWx3 uint8, already cropped the way the grading model crops.
        Each map is on its own model's grid; lesion_block rescales from there,
        so classes trained at different sizes mix without any extra care.
        """
        out = {}
        with self.torch.no_grad():
            for key, model in self.models.items():
                t = self._tensor(rgb, self.sizes[key])
                p = self.torch.sigmoid(model(t)).float().cpu().numpy()[0, 0]
                out[key] = p
        return out
