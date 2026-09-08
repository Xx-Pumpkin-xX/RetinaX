# Business Requirements Document
## RetinaX.ai — diabetic retinopathy screening support

| | |
|---|---|
| Version | 1.0 |
| Date | 8 September 2026 |
| Prepared for | USTH — Web Application Development, and competition submission |

---

## 1 · The problem

Diabetic retinopathy is the leading cause of preventable blindness in working-age
adults. It is also, for most of its course, silent: by the time a patient notices
their sight changing, the damage that caused it is established. This is why
screening exists — the disease is found by looking, not by waiting to be told.

Screening at national scale runs into a simple arithmetic problem. Vietnam has
several million people living with diabetes, each of whom should have a retinal
examination roughly every year, and a much smaller number of ophthalmologists.
Grading a fundus photograph is skilled work that takes a trained reader time, and
the great majority of photographs are normal. Most of that expert time is spent
confirming that nothing is wrong.

An automated grader can reduce that load. But an automated grader that a clinician
cannot interrogate creates a different problem: the clinician is asked to accept
or reject a number with no basis for judging it, and the sensible response to that
is to re-read every image anyway, which saves nobody anything.

## 2 · What this project proposes

A screening tool built on two commitments:

1. **Every machine grade is shown with the evidence for it.** A heatmap over the
   photograph, showing the regions that drove the model's output — so the
   clinician can see whether the model attended to a haemorrhage or to a
   reflection on the lens.
2. **The clinician's assessment is the record, and disagreement is kept.** When a
   clinician overrides a grade, both numbers are stored, along with the stated
   reason. The system never quietly replaces one with the other.

The second commitment is the one that matters commercially and clinically.
Disagreement is not an error to be suppressed; it is the most valuable data the
system produces. A dataset of *"the model said 2, an ophthalmologist said 4,
because of neovascularisation at the disc"* is exactly what the next model version
needs, and it is generated as a by-product of ordinary work.

## 3 · Stakeholders

| Stakeholder | Interest | What success looks like to them |
|---|---|---|
| **Screening clinician** | Grades a queue of photographs daily | Fewer normal images to read; enough visible evidence to trust a grade in seconds rather than re-reading it |
| **Ophthalmologist** | Receives referrals | Referrals arrive with a grade and a reason, and are appropriate |
| **Patient** | Wants to keep their sight | Disease found earlier, because more people are screened |
| **Clinic manager** | Throughput and liability | More patients screened per clinician-hour, with a defensible record of who decided what |
| **ML team** | Improves the model | A continuous supply of expert-corrected labels on real cases |
| **Course examiner** | Assesses the work | A working system whose design decisions are visible and defended |

## 4 · Business objectives

| ID | Objective | Measure |
|---|---|---|
| BO-1 | Reduce the clinician time spent per screened patient | Time to disposition per case, versus unaided reading |
| BO-2 | Make every machine grade auditable | 100 % of grades carry an explanation map |
| BO-3 | Preserve clinical authority | The clinician's assessment is the record of account in 100 % of cases |
| BO-4 | Capture disagreement as structured data | Every override carries a corrected grade and a written reason |
| BO-5 | Keep the system usable when the model is not | Sign-in, worklist and existing cases remain available during a model outage |
| BO-6 | Store no patient identity | No name, address or contact detail is captured anywhere |

## 5 · Scope

### 5.1 In scope

- Upload and grading of colour fundus photographs, one eye at a time, with both
  eyes of a patient entered together
- ICDR 0–4 grading with Grad-CAM++ explanation on every case, and the fused CCEM
  explanation on request
- Clinician review with agreement or a reasoned override, amendable, with full
  history
- Per-clinician worklist with search, status filtering, and a referable-only view
- Self-service accounts and password recovery

### 5.2 Out of scope

- Hospital system integration (PACS, EMR, DICOM, HL7)
- Multi-reader adjudication, second opinions, or a supervisor queue
- Image quality assessment or automatic rejection of ungradable photographs
- Patient-facing access to results
- Regulatory clearance as a medical device

### 5.3 Deliberately excluded, with reasons

| Excluded | Why |
|---|---|
| Storing patient names | Nothing in the clinical task requires identity. A patient code and birth year are enough to match a photograph to a person in the clinic's own records, and holding less means a breach costs less. |
| Showing the model's confidence score | A regression score between grade boundaries invites over-interpretation. The clinician is asked to judge the image and the evidence, not to negotiate with a number. |
| Letting the model's grade be edited | It is the measurement. Editing a measurement to match an opinion destroys the record that makes the system useful. |

## 6 · Success criteria

| ID | Criterion | Status |
|---|---|---|
| SC-1 | A clinician can upload a photograph and receive a grade with an explanation | ✅ verified end to end on GPU hardware |
| SC-2 | A clinician can override a grade, and both grades survive | ✅ verified across three successive amendments |
| SC-3 | A clinician cannot see another clinician's cases | ✅ verified on every route, including images |
| SC-4 | The system remains usable during a model outage | ✅ verified with the model unreachable |
| SC-5 | The system is reachable on a public URL, on a phone | ✅ deployed; first-party session cookie |
| SC-6 | No patient-identifying data is stored | ✅ by schema — there is no name column |

## 7 · Constraints

| ID | Constraint |
|---|---|
| BC-1 | Zero budget. Every hosting component runs on a free tier or on hardware the team already has. |
| BC-2 | The GPU is a shared research machine. It may be unavailable without notice, and the team does not have root on it. |
| BC-3 | No access to real patient images. Public research datasets only. |
| BC-4 | Three-person student team, built alongside coursework, against a fixed competition deadline. |
| BC-5 | The system is not a certified medical device and must present itself accordingly wherever a clinician can see it. |

## 8 · Risks

| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | Clinicians defer to the model rather than judging independently — automation bias | Severe: a systematic model error becomes a systematic clinical error | Explanation shown with every grade; disagreement is a first-class action; a standing notice on every screen states the clinician's assessment is the record |
| R-2 | The model underperforms on a local population it was not trained on | High | Overrides are captured with reasons, providing the data to measure and correct this |
| R-3 | The GPU host is unavailable during use | Medium | Architecture degrades rather than fails; existing cases and explanations remain fully available; failed grading is retryable |
| R-4 | A poor-quality photograph is graded as though it were adequate | Medium | Acknowledged limitation; gradability assessment is the first item of future work |
| R-5 | The system is mistaken for a diagnostic device | Severe (regulatory and clinical) | Scope stated in every document; a permanent notice on every clinical screen |
| R-6 | Data loss on a host without a backup | Low | Database and images on persistent storage; demonstration content reproducible from committed files |

## 9 · Assumptions

- Photographs reaching the system are colour fundus images of one eye, adequately
  focused and illuminated.
- One clinician is responsible for a case throughout its life; handover between
  clinicians is not modelled.
- The clinic already holds patient identity in its own records, and the patient
  code is sufficient to link back to it.

## 10 · Future work, in the order it should be done

1. **Gradability assessment.** Refuse to grade what cannot be graded. This is the
   most clinically significant gap.
2. **Retraining from captured overrides.** The data structure exists; the pipeline
   that consumes it does not.
3. **Second-reader adjudication.** Two clinicians, disagreement escalated, an
   agreed grade recorded.
4. **A managed database and object storage**, once more than one clinician writes
   concurrently.
5. **Email delivery for password reset**, which is currently written to a log.
6. **Prospective evaluation** against ophthalmologist grading on a local
   population, without which no performance claim should be made.
