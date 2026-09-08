"""
Describe the DR research repo for whoever has to write a serving wrapper.

Reads the source with `ast` rather than importing it, so nothing executes, no
CUDA is touched and no training side effects can fire.

    python inspect_repo.py ~/Projects/USTH/DR_project
    python inspect_repo.py ~/Projects/USTH/DR_project --pth <checkpoint>.pth

Writes retinax-repo-inspect.txt and prints a short summary. If the expected
folders are missing it maps whatever IS there instead of reporting nothing, and
it hunts for the checkpoint and threshold files rather than trusting the path
you typed.
"""
import argparse
import ast
import pathlib
import sys

PREFERRED = ["src/training", "src/xai/explanation", "src/xai/CCEM", "src/data"]

SKIP_DIRS = {"__pycache__", ".git", ".ipynb_checkpoints", "node_modules", ".venv",
             "venv", "env", "datasets", "dataset", "data_raw", "results", "outputs",
             "wandb", "runs", "Archive", "archive", ".mypy_cache", ".pytest_cache",
             "site-packages", "build", "dist", ".idea", ".vscode"}

PREPROC = ("Normalize", "Compose", "Resize", "CenterCrop", "circle_crop", "clahe",
           "CLAHE", "vessel", "ben_graham", "preprocess", "IMAGENET", "mean=", "std=",
           "ToTensor", "cv2.resize", "crop_", "img_size")

# Filename keywords decide which section a module lands in, so the report works
# whatever the folder layout turns out to be.
BUCKETS = [
    ("MODEL — how the network is built",
     ("model", "net", "arch", "backbone", "cbam", "efficientnet", "build", "train")),
    ("CCEM — the fusion layer",
     ("ccem", "fuse", "fusion", "consensus", "reliab", "calibrat")),
    ("EXPLAINERS — Grad-CAM++, Ada-SISE, SmoothIG",
     ("gradcam", "grad_cam", "cam", "sise", "smooth", "_ig", "ig_", "explain",
      "saliency", "attribut", "xai")),
    ("DATA / PREPROCESSING",
     ("data", "preprocess", "transform", "augment", "dataset", "loader", "fold")),
]


def sig(node):
    a = node.args
    parts = [x.arg for x in a.posonlyargs + a.args]
    defaults = [ast.unparse(d) for d in a.defaults]
    for i, d in enumerate(defaults):
        parts[len(parts) - len(defaults) + i] += f"={d}"
    if a.vararg:
        parts.append("*" + a.vararg.arg)
    for k, d in zip(a.kwonlyargs, a.kw_defaults):
        parts.append(k.arg + (f"={ast.unparse(d)}" if d is not None else ""))
    if a.kwarg:
        parts.append("**" + a.kwarg.arg)
    return f"{node.name}({', '.join(parts)})"


def parse(path):
    try:
        src = path.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(src)
    except (SyntaxError, OSError, UnicodeDecodeError):
        return [], [], [], []
    funcs, classes, consts = [], [], []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and not node.name.startswith("_"):
            funcs.append(sig(node))
        elif isinstance(node, ast.ClassDef):
            methods = [sig(m) for m in node.body
                       if isinstance(m, ast.FunctionDef)
                       and m.name in ("__init__", "forward", "__call__")]
            bases = ", ".join(ast.unparse(b) for b in node.bases)
            classes.append((f"{node.name}({bases})", methods))
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id.isupper():
                    try:
                        consts.append(f"{t.id} = {ast.unparse(node.value)[:100]}")
                    except Exception:
                        pass
    pre = []
    for i, line in enumerate(src.splitlines(), 1):
        t = line.strip()
        if t.startswith("#") or len(t) > 160:
            continue
        if any(h in line for h in PREPROC):
            pre.append((i, t[:120]))
    return funcs, classes, consts, pre


def collect(root):
    """Every .py worth reading, wherever it lives."""
    out = []
    for f in sorted(root.rglob("*.py")):
        if SKIP_DIRS & set(f.parts):
            continue
        if f.name.startswith("test_") or f.stem.endswith("_test"):
            continue
        out.append(f)
    return out


def bucket_of(path):
    stem = path.stem.lower()
    for name, words in BUCKETS:
        if any(w in stem for w in words):
            return name
    parent = str(path.parent).lower()
    for name, words in BUCKETS:
        if any(w in parent for w in words):
            return name
    return "OTHER"


def find_files(root, patterns, limit=25):
    hits, seen = [], set()
    for pat in patterns:
        for f in sorted(root.rglob(pat)):
            if SKIP_DIRS & set(f.parts) or f in seen:
                continue
            seen.add(f)
            hits.append(f)
            if len(hits) >= limit:
                return hits
    return hits


def inspect_checkpoint(pth, w):
    try:
        import torch
    except ImportError:
        w("  torch not importable here — re-run in the kernel that has it")
        return
    try:
        obj = torch.load(pth, map_location="cpu", weights_only=False)
    except Exception as e:
        w(f"  could not load {pth}: {e}")
        return
    w(f"  file: {pth}")
    w(f"  top-level type: {type(obj).__name__}")
    if not isinstance(obj, dict):
        w("  -> a pickled nn.Module: torch.load returns the model itself")
        return
    w(f"  dict keys: {list(obj.keys())[:12]}")
    state = obj.get("state_dict", obj.get("model", obj))
    if not isinstance(state, dict):
        return
    keys = [k for k in state if hasattr(state[k], "shape")]
    if not keys:
        return
    w(f"  tensor entries: {len(keys)}")
    w(f"  first: {keys[:4]}")
    w(f"  last : {keys[-4:]}")
    w(f"  prefixes: {sorted({k.split('.')[0] for k in keys})[:10]}")
    if any(k.startswith("module.") for k in keys):
        w("  !! keys prefixed 'module.' (DataParallel) — strip before load_state_dict")
    try:
        w(f"  parameters: {sum(state[k].numel() for k in keys)/1e6:.1f} M   (B7 alone ~66 M)")
    except Exception:
        pass
    head = [k for k in keys if any(s in k.lower() for s in ("fc", "head", "classifier", "linear"))]
    for k in head[-3:]:
        w(f"  head layer {k}: {tuple(state[k].shape)}   <- width says regression vs ordinal")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--pth")
    ap.add_argument("--thresholds")
    ap.add_argument("--out", default="retinax-repo-inspect.txt")
    args = ap.parse_args()

    root = pathlib.Path(args.repo).expanduser().resolve()
    if not root.exists():
        sys.exit(f"no such path: {root}")

    lines = []
    w = lines.append

    files = collect(root)
    w("=" * 74)
    w(f"RetinaX repo inspection — {root}")
    w(f"{len(files)} python files found")
    w("=" * 74)

    # --- 0. layout ---------------------------------------------------------
    # Printed first because the expected folders were missing once already:
    # better to see the real shape than to report nothing.
    w("\n\n## 0 · LAYOUT   (directories holding python, with file counts)")
    bydir = {}
    for f in files:
        bydir.setdefault(f.parent.relative_to(root), []).append(f.name)
    if not bydir:
        w("  no python files found at all — is this the right directory?")
        w(f"  immediate children of {root}:")
        for c in sorted(root.iterdir())[:40]:
            w(f"    {'d' if c.is_dir() else 'f'}  {c.name}")
    for d, names in sorted(bydir.items(), key=lambda kv: str(kv[0])):
        w(f"  {str(d) or '.':<46} {len(names):>3} files")
    missing = [p for p in PREFERRED if not (root / p).exists()]
    if missing:
        w(f"\n  note: expected folders not present: {', '.join(missing)}")
        w("  the sections below are grouped by filename instead of by folder")

    # --- 1. checkpoint -----------------------------------------------------
    w("\n\n## 1 · CHECKPOINT")
    pth = None
    if args.pth:
        for cand in (pathlib.Path(args.pth).expanduser(), root / args.pth):
            if cand.exists():
                pth = cand
                break
        if pth is None:
            w(f"  '{args.pth}' not found from here or under the repo root")
    if pth:
        inspect_checkpoint(pth, w)
    else:
        found = find_files(root, ["*.pth", "*.pt", "*.ckpt"])
        if found:
            w("  checkpoints found in the repo — re-run with --pth <one of these>:")
            for f in found:
                try:
                    n = f.stat().st_size
                    size = f"{n/1e6:.0f} MB" if n >= 1e6 else f"{n/1e3:.0f} KB"
                    w(f"    {f.relative_to(root)}   ({size})")
                except OSError:
                    w(f"    {f.relative_to(root)}")
        else:
            w("  no .pth/.pt/.ckpt under the repo — the weights live somewhere else")

    # --- 2. thresholds -----------------------------------------------------
    w("\n\n## 2 · THRESHOLDS")
    thr = None
    if args.thresholds:
        for cand in (pathlib.Path(args.thresholds).expanduser(), root / args.thresholds):
            if cand.exists():
                thr = cand
                break
    if thr is None:
        cands = find_files(root, ["*threshold*.npy", "*thresh*.npy", "*.npy"], limit=12)
        if cands:
            w("  candidates found — re-run with --thresholds <one of these>:")
            for f in cands:
                w(f"    {f.relative_to(root)}")
        else:
            w("  no .npy found under the repo")
    else:
        try:
            import numpy as np
            t = np.load(thr)
            w(f"  {thr}: shape {t.shape} values {t.ravel().tolist()}")
        except Exception as e:
            w(f"  could not read {thr}: {e}")

    parsed = {f: parse(f) for f in files}

    # --- 3. preprocessing --------------------------------------------------
    w("\n\n## 3 · PREPROCESSING   (must match training exactly — fails silently if not)")
    seen, shown = set(), 0
    for f in files:
        pre = parsed[f][3]
        keep = [(i, t) for i, t in pre if t not in seen]
        if not keep:
            continue
        for _, t in keep:
            seen.add(t)
        w(f"\n  {f.relative_to(root)}")
        for i, t in keep[:10]:
            w(f"    {i:>5}: {t}")
        shown += len(keep[:10])
        if shown > 110:
            w("\n  (truncated — enough to identify the transform)")
            break

    # --- 4+. callables, grouped by filename --------------------------------
    groups = {}
    for f in files:
        groups.setdefault(bucket_of(f), []).append(f)

    n = 4
    for name, _ in BUCKETS + [("OTHER", ())]:
        if name not in groups:
            continue
        w(f"\n\n## {n} · {name}")
        n += 1
        for f in groups[name]:
            funcs, classes, consts, _ = parsed[f]
            if not (funcs or classes or consts):
                continue
            w(f"\n  {f.relative_to(root)}")
            for c, methods in classes[:8]:
                w(f"    class {c}")
                for m in methods:
                    w(f"        {m}")
            for fn in funcs[:14]:
                w(f"    def {fn}")
            for c in consts[:8]:
                w(f"    {c}")

    text = "\n".join(lines) + "\n"
    out = pathlib.Path(args.out)
    out.write_text(text, encoding="utf-8")

    print(f"wrote {out}  ({len(text)/1024:.0f} KB, {len(lines)} lines)")
    print(f"  python files inspected : {len(files)}")
    print(f"  distinct preprocessing lines: {len(seen)}")
    print(f"  checkpoint : {'described' if pth else 'not found — see section 1 for candidates'}")
    print(f"  thresholds : {'read' if thr else 'not found — see section 2 for candidates'}")
    if not files:
        print("\n  NOTHING FOUND — check the path. Section 0 lists what is actually there.")
    print(f"\nOpen {out} and paste its contents back.")


if __name__ == "__main__":
    main()
