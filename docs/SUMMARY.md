# RetinaX.ai — project summary

**A diabetic retinopathy screening tool that shows its working, and keeps the
clinician's answer when the two disagree.**

| | |
|---|---|
| Live | `https://retinax.pages.dev` |
| Demo account | `quang@retinax.ai` / `retinax123` |
| Built | 5–8 September 2026, three-person team, USTH |
| Stack | React · Express · SQLite · FastAPI · PyTorch |

---

## What it does

A clinician uploads a colour fundus photograph. The system grades it on the
ICDR 0–4 scale using an EfficientNet-B7 with CBAM attention, and draws a heatmap
over the photograph showing the regions that drove that grade. The clinician then
agrees, or disagrees with a corrected grade and a written reason.

Both grades are kept. The model's grade is written once and never modified by
anything; the clinician's assessment lives in a separate table and can be amended
freely, with every version retained. That separation is the whole design.

## Why that separation matters

An automated grader that cannot be interrogated leaves a clinician with a number
and no basis for judging it — so the rational response is to re-read every image,
and nothing has been saved. Showing the evidence changes the question from
*"do you trust this system?"* to *"does this heatmap sit on a haemorrhage or on a
lens reflection?"*, which a clinician can answer in seconds.

And when a clinician overrides the model, that override is the most valuable thing
the system produces. *"The model said 2, an ophthalmologist said 4, because of
neovascularisation at the disc"* is precisely what the next model version needs to
learn from, and it falls out of ordinary clinical work rather than a labelling
exercise. A system that let the human answer overwrite the machine answer would
destroy that record every time it was used.

## Architecture

```
browser
   │  https, one origin only
   ▼
Cloudflare Pages ──── React app, and an /api proxy
   │  private
   ▼
storage host ──────── Express API · SQLite · images   (always on)
   │  Tailscale, never public
   ▼
DGX Spark ─────────── EfficientNet-B7 + CBAM, 600 px  (shared machine)
```

Three deliberate consequences:

**The browser only ever talks to one origin.** The session cookie is therefore
first-party. This was not the original design; it was changed after discovering
that a cross-site cookie is silently discarded by Safari, by Firefox, and by
Chrome in incognito — sign-in *appeared* to succeed and every subsequent request
was rejected. A reviewer on an iPhone could not have used the system at all.

**The model is not on the internet.** The inference service has no authentication
of its own, so it is reached over a private network rather than a public tunnel.

**Losing the GPU degrades the system rather than stopping it.** The GPU host is
shared research hardware that was unavailable for a full day during the build.
With it down: sign-in, the worklist, every existing case and both explanation maps
work normally. Only new grading fails, and it fails visibly — the case is marked
failed and offers to retry, rather than presenting a defaulted grade as though the
model had produced it.

## The model

| | |
|---|---|
| Architecture | EfficientNet-B7 (`tf_efficientnet_b7_ns`) with CBAM attention, single-output regression head |
| Input | 600 × 600, gray-crop then CLAHE, ImageNet normalisation |
| Inference | Three-view test-time augmentation, averaged |
| Grading | Nelder-Mead thresholds fitted after training: `[0.565, 1.441, 2.375, 3.042]` |
| Explanation | Grad-CAM++ on every case; CCEM — Grad-CAM++ ⊕ Ada-SISE ⊕ SmoothIG, adaptively weighted — on request |

The preprocessing chain is reproduced from the training code line by line, and the
thresholds are loaded from the file produced by the fit rather than hard-coded.
Both matter more than they look: skip the CLAHE step and the model still returns a
plausible number; use the unfitted default thresholds and every grade shifts, most
damagingly at the 3/4 boundary, which is the referral decision. The service
reports which thresholds it loaded, so this failure is visible from outside the
process instead of buried in a log line.

CCEM is a button rather than automatic because it runs hundreds of masked forward
passes and takes minutes of GPU time. Making every clinician wait for an
explanation most will not open is the wrong trade.

## The four rules the system enforces

| | Rule | Consequence if broken |
|---|---|---|
| **BR-1** | A clinician sees only their own cases | Ownership is in the SQL `WHERE` clause, so another clinician's row never leaves the database. Requests for someone else's case return **404, not 403** — 403 would confirm the case exists. |
| **BR-2** | A case is reviewable only once it has a grade | Agreeing with a grade that does not exist is not a decision a clinician can make, so the interface does not offer it and the API refuses it. |
| **BR-3** | Disagreement requires a corrected grade **and** a reason | A disagreement with no reason produces nothing anyone can learn from. |
| **BR-4** | The clinician's grade never overwrites the model's | This is the point of the system. |

Each was verified by attacking it, not by reading the code — including issuing a
second account one of the first account's case IDs and confirming 404 on the case,
the image, both heatmaps, the review route and the retry route.

## Design decisions worth defending out loud

**Dark by default.** Bright interface chrome around a dark fundus photograph
wrecks contrast judgement. Light is a preference, and it is remembered.

**The overlay is green.** A fundus photograph is orange; a red-yellow heat ramp on
an orange image is the one palette guaranteed to be hard to read, and worse again
for a red-green colour deficiency. Green sits opposite orange, and intensity is
carried by brightness as well as opacity, so the map survives a greyscale print.

**No patient names.** A patient code and a birth year. Nothing in the clinical task
needs identity, and holding less means a breach costs less.

**No confidence score shown.** A regression score between two grade boundaries
invites over-interpretation. The clinician is asked to judge the image and the
evidence, not to negotiate with a number.

**Open account creation.** Right for an evaluation build, where a reviewer must be
able to try the system on their own phone. Wrong for a hospital, which would
provision accounts centrally. Safe here because of BR-1 — a new account opens onto
its own empty worklist and can reach nothing else.

**A new account starts empty.** An earlier build seeded it with sample cases so the
first screen was never blank. That was removed: showing a clinician four
already-reviewed patients they never uploaded reads as invented history, which is
the exact opposite of what this system claims about its records.

## What is not built, and should be said plainly

1. **Image quality is not assessed.** A defocused or badly illuminated photograph
   is graded without complaint. For a screening tool used in earnest this is the
   most significant gap, and it is the first thing to build next.
2. **The model has not been evaluated on a Vietnamese screening population.** It
   was trained on public datasets skewed towards grade 0. No performance claim
   should be made until that evaluation exists.
3. **Password reset writes its link to the server log** instead of sending an
   email.
4. **Nothing consumes the captured overrides yet.** The data structure that makes
   retraining possible exists; the pipeline does not.
5. **The GPU service is started by hand** and does not survive a reboot of that
   machine unattended.

## Documents

| | |
|---|---|
| [`SRS.md`](SRS.md) | Software requirements specification — functional and non-functional requirements, business rules, interfaces, verification |
| [`BRD.md`](BRD.md) | Business requirements — problem, stakeholders, objectives, scope, risks |
| [`UML.md`](UML.md) | Use case and class models as built, and the corrections to make in StarUML |
| [`TECHNIQUES.md`](TECHNIQUES.md) | Every technique used and why, the bugs that taught something, and what we would do differently |
| [`../TRACEABILITY.md`](../TRACEABILITY.md) | Every use case and class mapped to the code that implements it, with commands a marker can run |
| [`../DEPLOY.md`](../DEPLOY.md) | Deployment runbook |
| [`../SETUP.md`](../SETUP.md) | Running the system locally, including the model |
| [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md) | Open defects and limitations |
