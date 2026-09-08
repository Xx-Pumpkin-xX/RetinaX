"""
How long does grading, and each XAI method, actually take on this machine?

My estimates for the Spark are extrapolated from specs and could be off by a
lot — EfficientNet is dominated by depthwise convolutions, which are
bandwidth-bound rather than FLOP-bound, and the Spark's 273 GB/s of unified
memory is modest next to its compute. So measure instead of trusting anyone's
arithmetic, including mine.

    python benchmark.py                      # torchvision B7, no weights needed
    python benchmark.py --pth model.pth      # your checkpoint
    python benchmark.py --size 456 --half    # cheaper settings

It prints per-image timings and then extrapolates what your CCEM configuration
would cost, because that is the number that decides the product design.
"""
import argparse, time, sys

import torch
import torch.nn as nn


def timed(fn, n, warmup=3):
    """Median of n runs. CUDA is asynchronous — without synchronize() you are
    timing how fast Python queues work, not how fast the GPU does it."""
    for _ in range(warmup):
        fn()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    samples = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        samples.append(time.perf_counter() - t0)
    samples.sort()
    return samples[len(samples) // 2]


def build(args, device):
    if args.pth:
        obj = torch.load(args.pth, map_location="cpu", weights_only=False)
        model = obj if isinstance(obj, nn.Module) else None
        if model is None:
            from torchvision.models import efficientnet_b7
            model = efficientnet_b7(weights=None)
            state = obj.get("state_dict", obj) if isinstance(obj, dict) else obj
            missing, unexpected = model.load_state_dict(state, strict=False)
            print(f"loaded state_dict  (missing {len(missing)}, unexpected {len(unexpected)})")
            print("   a large count here means the checkpoint is a different architecture —")
            print("   the timings stay valid, the numbers it produces do not.")
    else:
        from torchvision.models import efficientnet_b7
        model = efficientnet_b7(weights=None)
        print("no --pth given: using an untrained torchvision B7.")
        print("   Timings are architecture-dependent, not weight-dependent, so they still hold.")
    return model.eval().to(device)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pth")
    ap.add_argument("--size", type=int, default=600, help="input resolution (B7 native is 600)")
    ap.add_argument("--half", action="store_true", help="fp16 weights and activations")
    ap.add_argument("--runs", type=int, default=7)
    ap.add_argument("--ig-steps", type=int, default=20, help="your Integrated Gradients steps")
    ap.add_argument("--sg-samples", type=int, default=25, help="your SmoothGrad noise samples")
    ap.add_argument("--sise-passes", type=int, default=400, help="masked forwards in Ada-SISE")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"torch {torch.__version__} | device {device}")
    if device == "cuda":
        p = torch.cuda.get_device_properties(0)
        print(f"gpu   {p.name} | {p.total_memory / 1e9:.0f} GB")
    else:
        print("!! no CUDA — these numbers will be far slower than a GPU run")
    print()

    model = build(args, device)
    dtype = torch.float16 if args.half else torch.float32
    if args.half:
        model = model.half()
    print(f"input {args.size}x{args.size} | dtype {dtype}")
    print()

    def x(bs):
        return torch.randn(bs, 3, args.size, args.size, device=device, dtype=dtype)

    # ---- one image, forward only. This is what grading costs. ----------------
    inp = x(1)
    with torch.no_grad():
        fwd = timed(lambda: model(inp), args.runs)
    print(f"forward, batch 1            {fwd * 1000:8.0f} ms   <- one grading")

    # ---- forward + backward. This is what one Grad-CAM++ costs. --------------
    def fwd_bwd():
        i = x(1).requires_grad_(True)
        model(i).sum().backward()
    fb = timed(fwd_bwd, max(3, args.runs // 2))
    print(f"forward+backward, batch 1   {fb * 1000:8.0f} ms   <- one Grad-CAM++")
    print()

    # ---- how well does this machine batch? ----------------------------------
    # IG and SmoothGrad are hundreds of independent passes. Whether you batch
    # them is the difference between a minute and ten minutes.
    print("batched — per-sample cost is what matters, because IG and SmoothGrad")
    print("are hundreds of independent passes that can go through together:")
    grad_ps, fwd_ps = {1: fb}, {1: fwd}
    for bs in (2, 4, 8, 16, 32, 64):
        try:
            def batched_gr(bs=bs):
                i = x(bs).requires_grad_(True)
                model(i).sum().backward()
            def batched_fw(bs=bs):
                with torch.no_grad():
                    model(x(bs))
            tg = timed(batched_gr, 3, warmup=2)
            tf = timed(batched_fw, 3, warmup=2)
            grad_ps[bs], fwd_ps[bs] = tg / bs, tf / bs
            print(f"   batch {bs:<3} fwd+bwd {tg / bs * 1000:6.0f} ms/sample"
                  f"   fwd only {tf / bs * 1000:6.0f} ms/sample")
        except torch.cuda.OutOfMemoryError:
            print(f"   batch {bs:<3} out of memory — that is your ceiling")
            torch.cuda.empty_cache()
            break
    best_bs = min(grad_ps, key=grad_ps.get)
    best_grad, best_fwd = grad_ps[best_bs], min(fwd_ps.values())
    print(f"   best batch {best_bs}: {best_grad * 1000:.0f} ms/sample with gradients,"
          f" {best_fwd * 1000:.0f} ms without")
    print()

    # ---- what that means for CCEM -------------------------------------------
    sg_ig_passes = args.ig_steps * args.sg_samples
    sg_ig = sg_ig_passes * best_grad          # each step needs a gradient
    sise = args.sise_passes * best_fwd        # masked forwards, no gradients
    gradcam = fb
    total = gradcam + sise + sg_ig

    print("CCEM, extrapolated for one image")
    print(f"   Grad-CAM++      1 fwd+bwd                  {gradcam:8.1f} s")
    print(f"   Ada-SISE        {args.sise_passes} forwards{'':13}{sise:8.1f} s")
    print(f"   SmoothGrad-IG   {args.ig_steps}x{args.sg_samples} = {sg_ig_passes} fwd+bwd    {sg_ig:8.1f} s")
    print(f"   {'':43}{'-' * 10}")
    print(f"   total{'':38}{total:8.1f} s")
    print()
    if total > 45:
        print(f"   {total:.0f}s is longer than the API's 45s timeout, so full CCEM cannot")
        print("   run inside an upload request. Return the grade plus Grad-CAM++ live")
        print("   and precompute CCEM, or lower --ig-steps / --sg-samples and re-measure.")
    else:
        print("   That fits inside a request. Still worth checking it holds under load.")


if __name__ == "__main__":
    sys.exit(main())
