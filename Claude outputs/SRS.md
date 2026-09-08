# Software Requirements Specification
## RetinaX.ai — diabetic retinopathy screening support

| | |
|---|---|
| Version | 1.0 |
| Date | 8 September 2026 |
| Status | Implemented and deployed |
| Live system | `https://retinax.pages.dev` |

---

## 1 · Introduction

### 1.1 Purpose

This document specifies the requirements for **RetinaX.ai**, a web application that
helps a clinician grade diabetic retinopathy from colour fundus photographs. The
system produces a machine grade with a visual explanation, and records the
clinician's own assessment alongside it.

It is written for the development team, the course examiners, and any clinician
evaluating whether the system does what it claims.

### 1.2 Scope

RetinaX.ai is **decision support**, not diagnosis. Every grade the model produces
is presented as a proposal that a clinician confirms, corrects, or overrides. The
clinician's assessment is the record of account; the model's output is retained
beside it, never replaced by it.

**In scope**

- Upload of one or two fundus photographs per patient, one per eye
- Automatic DR grading on the ICDR 0–4 scale
- Visual explanation of each grade (Grad-CAM++, and CCEM on request)
- Clinician review: agree, or disagree with a corrected grade and a stated reason
- Amendment of a previous assessment, with every version retained
- A per-clinician worklist with search and filtering
- Account creation, sign-in, and password recovery

**Out of scope for this version**

- Integration with a hospital PACS, EMR, or DICOM workflow
- Multi-reader adjudication or a second-opinion queue
- Lesion segmentation or per-lesion annotation
- Any regulatory submission; the system is not a certified medical device

### 1.3 Definitions

| Term | Meaning |
|---|---|
| **DR** | Diabetic retinopathy |
| **ICDR** | International Clinical Diabetic Retinopathy severity scale, grades 0–4 |
| **NPDR / PDR** | Non-proliferative / proliferative diabetic retinopathy |
| **Referable DR** | Grade ≥ 2 (moderate NPDR or worse) — the threshold at which screening guidelines refer a patient to an ophthalmologist |
| **OD / OS** | *Oculus dexter* / *oculus sinister* — right eye / left eye |
| **Grad-CAM++** | Gradient-weighted class activation mapping; one backward pass |
| **CCEM** | Consensus-Calibrated Explanation Map — the project's fusion of Grad-CAM++, Ada-SISE and SmoothIG, weighted by adaptive reliability |
| **TTA** | Test-time augmentation; three views averaged, matching validation |
| **Case** | One photograph of one eye of one patient, with its grade and review |

### 1.4 Grade scale

| Grade | Label | Referable |
|---|---|---|
| 0 | No DR | no |
| 1 | Mild NPDR | no |
| 2 | Moderate NPDR | **yes** |
| 3 | Severe NPDR | **yes** |
| 4 | Proliferative DR | **yes** |

---

## 2 · Overall description

### 2.1 Product perspective

Three deployed components, deliberately separated so that the failure of the
most fragile one degrades the system rather than stopping it.

```
Cloudflare Pages          web/      the clinician's screens, and an /api proxy
storage host (prts-0)     server/   API, database, images        — always on
GPU host (DGX Spark)      ai/       EfficientNet-B7 + CBAM       — shared machine
```

The browser only ever contacts Cloudflare. `/api/*` is proxied from there to the
API host, so the session cookie is first-party and no cross-site request is made.
The API reaches the model over a private network (Tailscale), so the inference
service is never exposed to the internet.

**If the GPU host is unavailable**, sign-in, the worklist, every existing case and
both explanation maps continue to work. Only *new* grading fails, and it fails
visibly: the case is marked `FAILED` and offers to try again.

### 2.2 User classes

| Class | Description | Technical skill |
|---|---|---|
| **Clinician (Doctor)** | The only human actor. Uploads photographs, reviews grades, records assessments. Sees only their own cases. | Comfortable with a web application; no ML knowledge assumed |
| **Grading Model** | A system actor. Receives an image, returns a grade and explanation maps. | — |

There is no administrator role in this version. Account creation is open, which
is a demonstration decision recorded in §6.2.

### 2.3 Operating environment

- **Client**: any current browser, desktop or mobile. No installation.
- **API host**: Node.js ≥ 22.5 (uses the built-in `node:sqlite`), Linux.
- **Model host**: Linux with an NVIDIA GPU, PyTorch, `timm`, `albumentations`,
  `opencv`, `pytorch-grad-cam`, `captum`. Falls back to CPU on GPU exhaustion.

### 2.4 Design and implementation constraints

| | |
|---|---|
| C-1 | The model's grade must never be overwritten, by anything, ever. |
| C-2 | No patient name is stored. A case carries a patient code and a birth year only. |
| C-3 | Only public research datasets (APTOS 2019, EyePACS, Messidor-2) are used. No real patient data. |
| C-4 | The GPU host is shared and may be unavailable without notice. |
| C-5 | Passwords are stored as bcrypt hashes; password-reset tokens as SHA-256 hashes with an expiry. |

### 2.5 Assumptions

- Photographs are colour fundus images of adequate quality; the system does not
  assess image quality and will grade a poor photograph without complaint.
- One clinician owns a case for its lifetime. Handover is not modelled.

---

## 3 · Functional requirements

Each requirement carries the use case it belongs to and where it is implemented.

### 3.1 Authentication and accounts

| ID | Requirement | Priority | Implementation |
|---|---|---|---|
| FR-1 | A clinician shall sign in with an email address and password. | Must | `POST /api/login` |
| FR-2 | A session shall be carried in an `httpOnly` cookie, never in page-accessible storage. | Must | `issueSession()` |
| FR-3 | "Keep me signed in" shall extend the session to 14 days; otherwise 1 day. Neither shall be unlimited. | Must | `issueSession()` |
| FR-4 | A clinician shall create an account with a name, email, and a password of at least 8 characters. | Must | `POST /api/signup` |
| FR-5 | Registering an email that already exists shall be refused with a distinct error. | Must | 409 response |
| FR-6 | A new account's worklist shall start empty. | Must | §6.2 |
| FR-7 | A clinician shall request a password reset by email address. | Should | `POST /api/password/forgot` |
| FR-8 | The reset response shall be identical whether or not the address is registered. | Must | prevents account enumeration |
| FR-9 | A reset token shall be single-use, expire after 30 minutes, and be stored only as a hash. | Must | `ResetTokenHash`, `ResetTokenExpiry` |
| FR-10 | Sign-out shall clear the session cookie. | Must | `POST /api/logout` |
| FR-11 | The sign-in form shall not be pre-filled with any credentials. | Should | §6.2 |

### 3.2 Case creation

| ID | Requirement | Priority | Implementation |
|---|---|---|---|
| FR-12 | A clinician shall upload a fundus photograph with a patient code, eye position, and optionally birth year and sex. | Must | `POST /api/cases` |
| FR-13 | Both eyes of one patient shall be enterable in a single form, sharing the patient details. | Must | `NewCase.jsx` |
| FR-14 | Each photograph shall become its own case. One upload, one eye, one grade. | Must | — |
| FR-15 | If one eye fails to upload or grade, the other shall be unaffected. | Must | posted independently |
| FR-16 | Only JPEG and PNG shall be accepted, to a maximum of 12 MB. | Must | multer `fileFilter` |
| FR-17 | Uploading a case shall always invoke grading. | Must | UC-2 *includes* UC-3 |

### 3.3 Grading

| ID | Requirement | Priority | Implementation |
|---|---|---|---|
| FR-18 | The system shall return an integer grade 0–4 for a photograph. | Must | `POST /infer` |
| FR-19 | Preprocessing shall reproduce the training pipeline exactly: BGR→RGB, gray-crop, CLAHE, resize to 600², ImageNet normalisation. | Must | `dr_adapter.preprocess()` |
| FR-20 | Inference shall average three test-time augmentations, matching how the decision thresholds were fitted. | Must | `predict_score()` |
| FR-21 | The score shall be converted to a grade using the Nelder-Mead thresholds fitted after training, loaded from file. | Must | `score_to_grade()` |
| FR-22 | If those thresholds cannot be loaded, `/health` shall report that the fallback is in use. | Must | `thresholds_source` |
| FR-23 | A Grad-CAM++ explanation map shall be produced with every grade. | Must | `explain_gradcampp()` |
| FR-24 | A CCEM map shall be produced only on explicit request, not on upload. | Must | `POST /api/cases/:id/explain` |
| FR-25 | Requesting CCEM shall not recompute or alter the stored grade. | Must | `explainCcem()` |
| FR-26 | If grading fails, the case shall be marked `FAILED` and the failure shown to the clinician. | Must | 502 + `Status='FAILED'` |
| FR-27 | A failed case shall be re-gradable without re-uploading the photograph. | Should | `POST /api/cases/:id/regrade` |
| FR-28 | An unreachable model shall not hold an upload open indefinitely. | Must | `AI_TIMEOUT_MS`, 45 s |
| FR-29 | GPU exhaustion shall fall back to CPU rather than failing. | Should | `run_resilient()` |

### 3.4 Worklist

| ID | Requirement | Priority | Implementation |
|---|---|---|---|
| FR-30 | A clinician shall see a list of their own cases, most recent first. | Must | `GET /api/cases` |
| FR-31 | The two eyes of one patient shall be grouped together. | Should | `groupByPatient()` |
| FR-32 | Each patient group shall show the worse of the two grades, using the clinician's correction where one exists. | Should | `groupByPatient()` |
| FR-33 | The worklist shall be searchable by patient code, eye, and birth year. | Should | `matches()` |
| FR-34 | The worklist shall be filterable by status: all, awaiting review, reviewed, needs attention. | Should | `matches()` |
| FR-35 | The worklist shall be filterable to referable cases only (grade ≥ 2). | Should | `matches()` |
| FR-36 | While any case is being graded, the worklist shall refresh itself. | Should | 2 s poll |

### 3.5 Review

| ID | Requirement | Priority | Implementation |
|---|---|---|---|
| FR-37 | A case shall display the photograph, the model's grade, and the available explanation maps. | Must | `CaseDetail.jsx` |
| FR-38 | The overlay control shall offer only methods that case actually has a map for. | Must | `overlays` |
| FR-39 | The overlay shall be adjustable in opacity, and shall align exactly with the photograph. | Must | `object-fit: contain` on both |
| FR-40 | A clinician shall record agreement with the model's grade. | Must | `POST /api/cases/:id/mark` |
| FR-41 | A clinician shall record disagreement with a corrected grade **and** a written reason. | Must | BR-3 |
| FR-42 | A clinician shall amend a previous assessment. | Should | §3.5, BR-2 |
| FR-43 | Every assessment ever saved shall be retained and viewable, not overwritten. | Must | `reviews` table |
| FR-44 | A case with no grade shall offer no review controls. | Must | BR-2 |
| FR-45 | A standing notice shall state that the system is decision support and the clinician's assessment is the record. | Must | every screen |

### 3.6 Business rules

| ID | Rule | Enforced at | How to prove it |
|---|---|---|---|
| **BR-1** | A clinician sees only their own cases. | `ownCase()` — ownership is in the SQL `WHERE`, so another clinician's row never leaves the database | Sign in as B, request one of A's case IDs → **404** |
| **BR-2** | A case is reviewable only once it has a grade. | `POST /api/cases/:id/mark` | Mark a `FAILED` case → **409** |
| **BR-3** | Disagreement requires a corrected grade **and** a reason. | `POST /api/cases/:id/mark` | Disagree with an empty reason → **400** |
| **BR-4** | The clinician's grade never overwrites the model's. | The `UPDATE` names only `cases` columns; `predictions.Grade` is written once | Correct a grade, then read `predictions.Grade` — unchanged |

**BR-1 answers 404, not 403, deliberately.** `403 Forbidden` would confirm that
the case exists and belongs to someone else. `404` reveals nothing.

**BR-4 is the point of the system.** The model's grade and the clinician's grade
live in different tables and neither can overwrite the other. That is what makes
recorded disagreements usable as training signal for the next model version.

---

## 4 · Non-functional requirements

### 4.1 Performance

| ID | Requirement |
|---|---|
| NFR-1 | Grading one photograph shall complete within 45 s on the GPU host, or the request is abandoned. |
| NFR-2 | CCEM may take several minutes and shall therefore never run inside an upload request. |
| NFR-3 | The worklist shall render within 2 s for a clinician holding up to 500 cases. |

### 4.2 Security

| ID | Requirement |
|---|---|
| NFR-4 | Passwords shall be stored only as bcrypt hashes. |
| NFR-5 | Session tokens shall be JWTs in `httpOnly`, `Secure` cookies, never readable by page scripts. |
| NFR-6 | Uploaded images shall not be reachable except through an authenticated, ownership-checked route. There shall be no static file serving of the upload directory. |
| NFR-7 | The inference service shall not be reachable from the public internet. |
| NFR-8 | All traffic between the browser and the system shall be over HTTPS. |
| NFR-9 | The session cookie shall be first-party, so that browsers blocking third-party cookies do not break sign-in. |

### 4.3 Reliability

| ID | Requirement |
|---|---|
| NFR-10 | Loss of the GPU host shall not prevent sign-in, browsing cases, or viewing existing explanations. |
| NFR-11 | A failure to grade shall be reported honestly. The system shall never present a fabricated or defaulted grade as a model output. |
| NFR-12 | The database and uploaded images shall persist across restarts and deployments. |

### 4.4 Usability

| ID | Requirement |
|---|---|
| NFR-13 | The interface shall default to a dark theme, because bright surroundings degrade contrast judgement on a dark fundus photograph. A light theme shall be selectable and remembered. |
| NFR-14 | The explanation overlay shall be legible over an orange fundus photograph, and shall not rely on a red–green distinction. |
| NFR-15 | Every failure state shall say what happened and what the clinician can do next. |

### 4.5 Maintainability

| ID | Requirement |
|---|---|
| NFR-16 | The research model shall be reached through a single adapter module, so that the application does not depend on the research repository's internal structure. |
| NFR-17 | Preprocessing shall be traceable, line by line, to the training code. |

---

## 5 · External interfaces

### 5.1 API

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/signup` | Create an account and sign in | — |
| POST | `/api/login` | Sign in | — |
| POST | `/api/logout` | Sign out | — |
| GET | `/api/me` | The signed-in clinician | ✓ |
| POST | `/api/password/forgot` | Request a reset link | — |
| POST | `/api/password/reset` | Set a new password from a token | — |
| GET | `/api/cases` | The worklist | ✓ |
| POST | `/api/cases` | Upload and grade a photograph | ✓ |
| GET | `/api/cases/:id` | One case, with its review history | ✓ |
| GET | `/api/cases/:id/image` | The photograph | ✓ |
| GET | `/api/cases/:id/heatmap/:method` | `cam` or `ccem` overlay | ✓ |
| POST | `/api/cases/:id/mark` | Record or amend an assessment | ✓ |
| POST | `/api/cases/:id/regrade` | Retry a failed grading | ✓ |
| POST | `/api/cases/:id/explain` | Compute the CCEM map | ✓ |

### 5.2 Grading service

```
POST {AI_URL}/infer            multipart, field "file"
     ?ccem=true                also compute the fused map

  -> { "grade": 0..4,
       "heatmap_cam_png_base64":  string | null,
       "heatmap_ccem_png_base64": string | null }

GET  {AI_URL}/health
  -> { "model_loaded": bool, "device": "cuda"|"cpu",
       "thresholds": [f,f,f,f], "thresholds_source": string, ... }
```

The regression score and the decision thresholds stay inside the service. The
application receives a grade and a picture, and has no way to reinterpret either.

---

## 6 · Decisions recorded

### 6.1 SQLite rather than a database server

The data lives in a SQLite file on the storage host, not in a managed database.
For a system of this size, with one writer and a handful of readers, this is
adequate and removes an entire operational dependency. Moving to PostgreSQL would
be a contained change to `db.js` and the route handlers, and is the correct step
if concurrent writers or reporting are ever required.

### 6.2 Open account creation

Anyone may create an account. A hospital deployment would provision accounts
centrally, and this would be wrong there. It is right for an evaluation build,
where a reviewer must be able to try the system on their own device. It is safe
because of BR-1: a new account opens onto its own empty worklist and can reach
nothing else.

New accounts start **empty**. An earlier build seeded them with sample cases so
that the first screen was never blank; that was removed because presenting a
clinician with four already-reviewed patients they never uploaded reads as
invented history, which is the precise opposite of what this system claims.

### 6.3 CCEM on request

CCEM fuses three explainers, one of which runs hundreds of masked forward passes.
It is minutes of GPU time. Running it inside every upload would make every
clinician wait for an explanation most of them will not open. It is therefore a
button.

---

## 7 · Verification

| Requirement | How it was verified |
|---|---|
| BR-1 | Second account issued one of the first account's case IDs: 404 on the case, the image, both heatmaps, the mark route, and the regrade route. Worklist returned `[]`. |
| BR-2 | Marking a `FAILED` case returned 409. |
| BR-3 | Disagreement with an empty reason returned 400. |
| BR-4 | Three successive amendments — agree, disagree 4, agree — left `predictions.Grade` at 2 throughout, with all three assessments retained. |
| FR-27 | Upload with the model unreachable → `FAILED`; regrade while still unreachable → 502, still `FAILED`; regrade with the model up → `GRADED` with a map. |
| FR-43 | Review history returned three entries in order after three assessments. |
| NFR-6 | `GET /uploads/<real filename>` → 404. Path traversal via the case route → 404. |
| NFR-9 | Verified by failure: in a third-party-cookie-blocking context, sign-in appeared to succeed and every later request returned 401. Fixed by proxying the API through the site's own origin. |
| NFR-10 | With the model unreachable: sign-in, worklist, all cases and both heatmap types served normally. |

---

## 8 · Known limitations

1. **Image quality is not assessed.** A defocused or poorly illuminated
   photograph is graded without comment. A screening tool used in earnest needs a
   gradability check first.
2. **The model was trained on public datasets** (APTOS 2019, Messidor-2) whose
   class balance is skewed towards grade 0. Performance on a Vietnamese screening
   population is unmeasured.
3. **Password reset prints its link to the server log** rather than sending an
   email. Wiring a mail provider is one function; it has not been done.
4. **The GPU host is a shared machine** started by hand. It has no supervisor and
   does not restart on reboot.
5. **No audit of viewing.** Amendments are recorded; who *looked* at a case is not.
