"""Train one small segmentation model per lesion class, on a clock.

WHY A TIME BUDGET AND NOT AN EPOCH COUNT
----------------------------------------
Six models have to fit in one night. Epochs are the wrong unit for that: a class
with 200 positive images and a class with 1400 do not take the same time per
epoch, so a fixed epoch count silently spends the whole night on the first two
classes. --minutes gives every class the same wall clock, checkpoints the best
validation score so far, and stops. Whatever the night produces is usable in the
morning, even if it is four classes out of six.

WHAT THE MORNING NEEDS FROM THIS
--------------------------------
weights/<KEY>.pth   the best checkpoint
weights/<KEY>.json  recall, precision, dice on held-out data, per threshold

The JSON is the point. `ai/lesion_regions.py` keeps IRMA and NV in NOT_CREDIBLE
until someone can quote a recall for them, and this file is where that number
comes from. A class does not leave that set because its loss went down.

RUN IT
------
    python train_lesions.py --root /path/to/FGADR --probe
    python train_lesions.py --root /path/to/FGADR --minutes 60
    python train_lesions.py --root /path/to/FGADR --minutes 60 --only MA,HE

--probe touches no GPU: it prints what it found on disk and exits. Run it first.
Restartable: a class whose .pth already exists is skipped unless --force.
"""

import argparse, glob, json, os, random, re, time
from pathlib import Path

import cv2
import numpy as np

CLASSES = ["MA", "HE", "EX", "SE", "IRMA", "NV"]

# FGADR's mask folders are named inconsistently and one of them is misspelled in
# the distributed archive, so matching is by keyword rather than exact name.
PATTERNS = {
    "MA":   [r"microaneurysm"],
    "HE":   [r"hemohedge", r"h[ae]emorrhage", r"hemorrhage"],
    "EX":   [r"hard.?exudate"],
    "SE":   [r"soft.?exudate", r"cotton"],
    "IRMA": [r"irma", r"intraretinal"],
    "NV":   [r"neovascular"],
}

IMG_EXT = (".png", ".jpg", ".jpeg", ".tif", ".tiff")


# --------------------------------------------------------------- discovery ---
def discover(root):
    """{key: (images_dir, masks_dir)} by scanning, not by hardcoded paths."""
    root = Path(root)
    dirs = [p for p in root.rglob("*") if p.is_dir()]

    images = None
    for p in dirs:
        if re.search(r"original.?image|^images$", p.name, re.I):
            n = sum(1 for f in p.iterdir() if f.suffix.lower() in IMG_EXT)
            if n and (images is None or n > images[1]):
                images = (p, n)
    if images is None:
        raise SystemExit(f"!! no Original_Images-like folder under {root}")

    found = {}
    for key, pats in PATTERNS.items():
        for p in dirs:
            if any(re.search(pat, p.name, re.I) for pat in pats):
                n = sum(1 for f in p.iterdir() if f.suffix.lower() in IMG_EXT)
                if n:
                    found[key] = (images[0], p)
                    break
    return found


def pairs(images_dir, masks_dir):
    """[(image, mask)] matched on stem, because extensions differ per folder."""
    by_stem = {}
    for f in Path(images_dir).iterdir():
        if f.suffix.lower() in IMG_EXT:
            by_stem[f.stem] = f
    out = []
    for m in sorted(Path(masks_dir).iterdir()):
        if m.suffix.lower() in IMG_EXT and m.stem in by_stem:
            out.append((by_stem[m.stem], m))
    return out


# ----------------------------------------------------------------- dataset ---
class LesionSet:
    def __init__(self, items, size, train):
        self.items, self.size, self.train = items, size, train

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        ip, mp = self.items[i]
        img = cv2.cvtColor(cv2.imread(str(ip), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
        msk = cv2.imread(str(mp), cv2.IMREAD_GRAYSCALE)
        if msk is None:
            msk = np.zeros(img.shape[:2], np.uint8)

        s = self.size
        img = cv2.resize(img, (s, s), interpolation=cv2.INTER_AREA)
        # NEAREST on the mask: any interpolation invents grey edges, and a
        # microaneurysm is small enough to be entirely edge.
        msk = cv2.resize(msk, (s, s), interpolation=cv2.INTER_NEAREST)

        if self.train:
            if random.random() < 0.5:
                img, msk = img[:, ::-1], msk[:, ::-1]
            if random.random() < 0.5:
                img, msk = img[::-1], msk[::-1]
            k = random.randint(0, 3)
            if k:
                img, msk = np.rot90(img, k), np.rot90(msk, k)

        img = np.ascontiguousarray(img).astype(np.float32) / 255.0
        img = (img - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        msk = (np.ascontiguousarray(msk) > 127).astype(np.float32)
        return img.transpose(2, 0, 1), msk[None]


# ------------------------------------------------------------------- train ---
def build(encoder):
    """ImageNet weights if they can be fetched, random if not.

    The DGX may have no route to the weight host at 1 a.m., and a download
    error there would kill the whole night. Random init trains worse; it does
    not train not-at-all, and the fallback is printed so nobody later wonders
    why the numbers are low.
    """
    import segmentation_models_pytorch as smp
    try:
        return smp.Unet(encoder_name=encoder, encoder_weights="imagenet",
                        in_channels=3, classes=1)
    except Exception as e:
        print(f"   !! imagenet weights unavailable ({type(e).__name__}) — random init")
        return smp.Unet(encoder_name=encoder, encoder_weights=None,
                        in_channels=3, classes=1)


def focal_tversky(logits, target, alpha=0.3, beta=0.7, gamma=0.75, eps=1e-6):
    """Tversky with beta > alpha punishes MISSED lesions harder than false ones.

    That asymmetry is deliberate and is the whole reason this is not plain Dice:
    for classes where a few hundred pixels are positive out of a million, a model
    trained on a symmetric loss reaches a beautiful loss value by predicting
    nothing at all. Recall is what the morning cares about.
    """
    import torch
    p = torch.sigmoid(logits)
    tp = (p * target).sum((1, 2, 3))
    fp = (p * (1 - target)).sum((1, 2, 3))
    fn = ((1 - p) * target).sum((1, 2, 3))
    t = (tp + eps) / (tp + alpha * fp + beta * fn + eps)
    return ((1 - t) ** gamma).mean()


def evaluate(model, loader, device, thresholds):
    import torch
    model.eval()
    stat = {t: [0, 0, 0] for t in thresholds}          # tp, fp, fn
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            with torch.autocast("cuda", enabled=device.type == "cuda"):
                p = torch.sigmoid(model(x)).float()
            for t in thresholds:
                b = (p >= t).float()
                stat[t][0] += float((b * y).sum())
                stat[t][1] += float((b * (1 - y)).sum())
                stat[t][2] += float(((1 - b) * y).sum())
    out = {}
    for t, (tp, fp, fn) in stat.items():
        rec = tp / (tp + fn) if tp + fn else 0.0
        pre = tp / (tp + fp) if tp + fp else 0.0
        dice = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else 0.0
        out[f"{t:.2f}"] = {"recall": round(rec, 4), "precision": round(pre, 4),
                           "dice": round(dice, 4)}
    return out


def train_one(key, items, args, outdir):
    import torch
    from torch.utils.data import DataLoader

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Positives first. An all-negative image is a real training signal - it is
    # what teaches the model not to fire on the optic disc - but FGADR has far
    # more of them than positives for the rare classes, and left unbalanced the
    # model learns that predicting nothing is almost always right.
    cache = outdir / f"{key}.split.json"
    known = json.loads(cache.read_text()) if cache.exists() else None

    pos, neg = [], []
    if known:
        want = set(known["positive"])
        for ip, mp in items:
            (pos if str(mp) in want else neg).append((ip, mp))
    else:
        for ip, mp in items:
            m = cv2.imread(str(mp), cv2.IMREAD_GRAYSCALE)
            (pos if m is not None and (m > 127).any() else neg).append((ip, mp))
        cache.write_text(json.dumps({"positive": [str(mp) for _, mp in pos]}))
    random.Random(0).shuffle(neg)
    use = pos + neg[: len(pos)]
    random.Random(1).shuffle(use)
    if len(pos) < 12:
        print(f"   !! only {len(pos)} positive images — this class will not learn")

    cut = max(1, int(len(use) * 0.15))
    val, trn = use[:cut], use[cut:]

    dl = lambda s, sh: DataLoader(s, batch_size=args.batch, shuffle=sh,
                                  num_workers=args.workers, pin_memory=True, drop_last=sh)
    tl = dl(LesionSet(trn, args.size, True), True)
    vl = dl(LesionSet(val, args.size, False), False)

    model = build(args.encoder).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")

    print(f"   {len(pos)} positive / {len(neg)} negative → train {len(trn)}, val {len(val)}")

    deadline = time.time() + args.minutes * 60
    best, best_at, epoch = -1.0, None, 0

    while time.time() < deadline:
        epoch += 1
        model.train()
        run, n = 0.0, 0
        for x, y in tl:
            if time.time() > deadline:
                break
            x, y = x.to(device, non_blocking=True), y.to(device, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.autocast("cuda", enabled=device.type == "cuda"):
                loss = focal_tversky(model(x), y)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            run += float(loss); n += 1

        m = evaluate(model, vl, device, args.thresholds)
        # Ranked on dice at 0.50 so the checkpoint is not chosen by a threshold
        # the server does not use. Every threshold is still recorded.
        score = m[f"{0.50:.2f}"]["dice"]
        left = int(deadline - time.time())
        print(f"   epoch {epoch:>3}  loss {run / max(n, 1):.4f}  "
              f"dice@.5 {score:.4f}  recall@.5 {m['0.50']['recall']:.4f}  {left}s left")

        if score > best:
            best, best_at = score, m
            torch.save({"state_dict": model.state_dict(), "encoder": args.encoder,
                        "size": args.size, "key": key}, outdir / f"{key}.pth")

    (outdir / f"{key}.json").write_text(json.dumps({
        "key": key, "encoder": args.encoder, "size": args.size,
        "epochs": epoch, "minutes": args.minutes,
        "positives": len(pos), "train": len(trn), "val": len(val),
        "best_dice_at_0.50": best, "metrics": best_at,
    }, indent=2))
    print(f"   saved {key}.pth  best dice@.5 {best:.4f}")
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="FGADR root (Seg-set's parent is fine)")
    ap.add_argument("--out", default="weights")
    ap.add_argument("--minutes", type=float, default=60, help="wall clock PER CLASS")
    ap.add_argument("--size", type=int, default=768)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--encoder", default="resnet34")
    ap.add_argument("--only", default="", help="comma-separated keys")
    ap.add_argument("--probe", action="store_true", help="print what is on disk and exit")
    ap.add_argument("--force", action="store_true", help="retrain classes that already have weights")
    args = ap.parse_args()
    args.thresholds = [0.30, 0.40, 0.50, 0.60, 0.70]

    found = discover(args.root)
    wanted = [k for k in CLASSES if k in found]
    if args.only:
        pick = {k.strip().upper() for k in args.only.split(",")}
        wanted = [k for k in wanted if k in pick]

    print(f"root: {args.root}")
    for k in CLASSES:
        if k not in found:
            print(f"  {k:<5} -- no mask folder found")
            continue
        img_d, msk_d = found[k]
        pr = pairs(img_d, msk_d)
        print(f"  {k:<5} {len(pr):>5} image/mask pairs   {msk_d.name}")
    missing = [k for k in CLASSES if k not in found]
    if missing:
        print(f"\n  classes with no data: {', '.join(missing)} "
              f"— these stay not_assessed in the UI, which is correct.")
    if args.probe:
        return

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    print(f"\ntraining {len(wanted)} classes x {args.minutes} min "
          f"≈ {len(wanted) * args.minutes / 60:.1f} h\n")

    for k in wanted:
        if (outdir / f"{k}.pth").exists() and not args.force:
            print(f"== {k}: already has weights, skipping (--force to redo)")
            continue
        print(f"== {k}")
        try:
            train_one(k, pairs(*found[k]), args, outdir)
        except Exception as e:                       # one bad class must not
            print(f"   !! {k} failed: {e}")          # cost the other five
        print()


if __name__ == "__main__":
    main()
