#!/usr/bin/env python3
"""
Pull a small, balanced sample out of APTOS 2019 and zip it with its labels.

    python3 sample_aptos.py                      # 3 per class, 15 images
    python3 sample_aptos.py --per-class 5        # 25 images
    python3 sample_aptos.py --root /path/to/APTOS

Images come from train_images, not test_images: the APTOS test set ships
unlabelled (test.csv is just id_code), so there is no grade to sample by. The
grades are the diagnosis column of train.csv.

The grade is NOT written into the filename. It goes in grades.csv only, so you
can upload an image and read the model's answer without having already seen the
ground truth on the file you just picked.
"""
import argparse
import csv
import pathlib
import random
import sys
import zipfile
from collections import defaultdict

LABELS = {
    0: "No DR",
    1: "Mild NPDR",
    2: "Moderate NPDR",
    3: "Severe NPDR",
    4: "Proliferative DR",
}


def find_image(images_dir: pathlib.Path, id_code: str) -> pathlib.Path | None:
    """APTOS is .png in some mirrors and .jpg in others; take whichever exists."""
    for ext in (".png", ".jpg", ".jpeg", ".PNG", ".JPG"):
        p = images_dir / f"{id_code}{ext}"
        if p.is_file():
            return p
    return None


def main() -> int:
    here = pathlib.Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=pathlib.Path, default=here,
                    help="the APTOS folder holding train.csv and train_images/")
    ap.add_argument("--per-class", type=int, default=3)
    ap.add_argument("--seed", type=int, default=42,
                    help="fixed so the same sample comes back if you rerun it")
    ap.add_argument("--out", type=pathlib.Path, default=None)
    args = ap.parse_args()

    root = args.root.expanduser().resolve()
    csv_path = root / "train.csv"
    images_dir = root / "train_images"
    out_zip = args.out or (root / f"aptos_sample_{args.per_class}x5.zip")

    if not csv_path.is_file():
        print(f"!! {csv_path} not found. Point --root at the folder containing train.csv.",
              file=sys.stderr)
        return 1
    if not images_dir.is_dir():
        print(f"!! {images_dir} not found.", file=sys.stderr)
        return 1

    # group every id by its grade
    by_grade: dict[int, list[str]] = defaultdict(list)
    with csv_path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                by_grade[int(row["diagnosis"])].append(row["id_code"])
            except (KeyError, ValueError):
                print(f"!! unexpected row in train.csv: {row}", file=sys.stderr)
                return 1

    rng = random.Random(args.seed)
    picked: list[tuple[str, int, pathlib.Path]] = []
    for grade in sorted(LABELS):
        ids = by_grade.get(grade, [])
        if not ids:
            print(f"!! no images with grade {grade} in train.csv", file=sys.stderr)
            return 1
        rng.shuffle(ids)

        # Walk the shuffled list rather than taking a slice: an id in the csv
        # whose file is missing from disk should cost one candidate, not one
        # of the images you asked for.
        taken = 0
        for id_code in ids:
            if taken == args.per_class:
                break
            path = find_image(images_dir, id_code)
            if path is None:
                continue
            picked.append((id_code, grade, path))
            taken += 1
        if taken < args.per_class:
            print(f"!! only found {taken} of {args.per_class} files for grade {grade}",
                  file=sys.stderr)
            return 1

    rows = [
        {"filename": p.name, "id_code": i, "grade": g, "label": LABELS[g]}
        for i, g, p in picked
    ]

    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for _, _, path in picked:
            z.write(path, arcname=path.name)
        import io
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=["filename", "id_code", "grade", "label"])
        w.writeheader()
        w.writerows(rows)
        z.writestr("grades.csv", buf.getvalue())

    print(f"wrote {out_zip}  ({out_zip.stat().st_size / 1024:.0f} KB)")
    for grade in sorted(LABELS):
        names = [r["filename"] for r in rows if r["grade"] == grade]
        print(f"  grade {grade}  {LABELS[grade]:<17} {', '.join(names)}")
    print(f"\n{len(rows)} images + grades.csv")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
