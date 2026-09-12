# Traceability – design to code

Every use case, class and screen in the UML model, and the line of code that
implements it. Written so a marker can check the claim rather than take it on
trust, and so the team can see immediately when a diagram and the code drift
apart.

Verified against the running application on 7 September 2026.

---

## Use cases → code

| UC | Name | Screen | Route | Server |
|---|---|---|---|---|
| UC-1 | Log in | `pages/Login.jsx` (login state) | `POST /api/login` | `server.js:52` |
| UC-2 | Upload Case | `pages/NewCase.jsx` | `POST /api/cases` (multipart) | `server.js:186` |
| UC-3 | Grade Image *(Model)* | – no screen, it is the Model actor | `POST :8000/infer` | `ai.js` → `ai/main.py` |
| UC-4 | View Cases | `pages/Cases.jsx` | `GET /api/cases` | `server.js:157` |
| UC-5 | Review Result | `pages/CaseDetail.jsx` | `GET /api/cases/:id` | `server.js:180` |
| UC-6 | Record Grade *(extends UC-5)* | `CaseDetail.jsx`, correction form | `POST /api/cases/:id/mark` | `server.js:218` |
| UC-7 | Recover Password | `Login.jsx` (forgot + reset states) | `POST /api/password/forgot` · `/reset` | `server.js:91`, `:112` |
| – | *Sign up* | `Login.jsx` (signup tab) | `POST /api/signup` | `server.js:96` |

**Sign-up is not in the use case diagram**, and that is a decision rather than an
omission: the model was drawn for a clinic where accounts are provisioned. If the
report presents sign-up as a feature, add UC-8 and an association from Doctor;
if it presents it as demo scaffolding, leave the diagram alone and say so.

**One upload is still one case.** New Case offers two photograph slots so a
patient's eyes are entered together, but each photograph is posted separately and
becomes its own case. `POST /api/cases` and UC-2 are unchanged – the form calls
the use case twice, which is not the same as the use case changing.

**`include` – UC-2 includes UC-3.** Not a diagram convenience: `POST /api/cases`
calls `gradeImage()` inside the same request before it answers. Uploading a case
*always* grades it. That is what `include` means, and the code matches.

**`extend` – UC-6 extends UC-5.** Reviewing a result does not require recording
a corrected grade; agreeing is one click and writes no grade. The correction form
only appears when the doctor chooses Disagree. Optional behaviour on top of a
complete use case – an `extend`, and the code matches.

### Supporting routes, which are not use cases

`POST /api/logout` · `GET /api/me` · `GET /api/cases/:id/image` ·
`GET /api/cases/:id/heatmap`. Session mechanics and file serving. They carry no
user goal, so they are deliberately absent from the use case diagram – a use case
is something an actor wants, not every HTTP call the browser makes. Worth saying
in the report, because a marker counting routes against use cases will notice.

---

## Classes → tables

| Class | Table | Attributes as drawn | Deviations |
|---|---|---|---|
| Doctor | `doctors` | DoctorID, FullName, Email, Password, ResetToken, ResetTokenExpiry | `Password` is `PasswordHash` (bcrypt); `ResetToken` is `ResetTokenHash` (SHA-256). Both are the same attribute, stored safely. |
| Case | `cases` | CaseID, DoctorID, PatientCode, BirthYear, PatientSex, EyePosition, ImagePath, Status, Agreement, CorrectedGrade, Reason, CreatedAt | **plus `ReviewedAt`** – add it to the class diagram |
| Prediction | `predictions` | PredictionID, CaseID, Grade, Heatmap, CreatedAt | **no `Score`**, and `Heatmap` is now **two** attributes – see below |

Relationships as drawn: `Doctor 1 → 0..* Case` is the `DoctorID` foreign key;
`Case 1 → 0..1 Prediction` is the `UNIQUE` constraint on `predictions.CaseID`,
which is what enforces the *at most one* prediction per case.

### Two corrections to make in StarUML

1. **Remove `Score` from Prediction.** The design doc still says to store it. That
   contradicts the decision that the regression score and the Nelder-Mead
   thresholds stay inside the model – the service returns a grade and a heatmap
   and nothing else. The code has no `Score` column. The diagram should not either.
2. **Add `ReviewedAt` to Case.** The code records when the doctor reviewed; the
   class diagram does not list it.
3. **Split `Heatmap` into `HeatmapCam` and `HeatmapCcem` on Prediction.** The case
   screen offers Grad-CAM++ and CCEM as separate overlays, so there are two maps,
   not one. Grad-CAM++ is a single backward pass and is produced on upload; CCEM
   fuses three explainers and is produced in a batch run, so it can be absent.
   `HeatmapCcem` is therefore nullable in a way `HeatmapCam` usually is not.

Nothing else differs. Password recovery is two nullable columns on `Doctor`, as
drawn – not a fourth class.

---

## Business rules → enforcement

| | Rule | Enforced at | How to prove it |
|---|---|---|---|
| BR-1 | A doctor sees only their own cases | `ownCase()`, `server.js` | Sign in as Ha, request one of Quang's case IDs → **404** |
| BR-2 | Review only while status is `GRADED` | `POST /api/cases/:id/mark` | Mark a case twice → second returns **409** |
| BR-3 | Disagree requires a grade **and** a reason | `POST /api/cases/:id/mark` | Disagree with an empty reason → **400** |
| BR-4 | The doctor's grade never overwrites the model's | the `UPDATE` names only `cases` columns | Correct a grade, then read `predictions.Grade` – unchanged |

**BR-1 returns 404, not 403,** on purpose. `403 Forbidden` would confirm that the
case exists and belongs to someone else. `404` reveals nothing. Say this out loud
in the report; it is the kind of decision that separates a working prototype from
one built with the data in mind.

**BR-4 is the point of the whole system.** The model's grade and the doctor's
grade are stored in different tables and neither can overwrite the other. That is
what makes disagreements usable as training signal for the next model version,
and it is the thing to demonstrate live.

---

## Screens → mockups

| Mockup | Built as | |
|---|---|---|
| 1 Loading | the `me === undefined` branch in `App.jsx` | ✅ |
| 2 Log in / Sign up | `pages/Login.jsx` | ✅ both tabs |
| 3 My cases | `pages/Cases.jsx` | ✅ |
| 4 New case | `pages/NewCase.jsx` | ✅ |
| 5 Case detail – agree | `pages/CaseDetail.jsx` | ✅ |
| 6 Case detail – disagree | same screen, correction form open | ✅ |

**Sign-up is open, and that is a demo decision worth defending out loud.**
`POST /api/signup` lets anyone create an account, which is what a competition
showcase needs – a judge can try the tool on their own phone.

It is safe because of BR-1, not in spite of it: a doctor only ever sees cases
where `DoctorID` is their own, so a new account opens onto its own work and
nothing else. Verified both directions – a new account's worklist comes back
empty, and each account returns 404 for the other's case IDs.

**A new account starts with nothing, and that is deliberate.** Sign-up used to
seed the new doctor a copy of the demo cases so a judge never saw a blank page.
It was removed: showing a doctor four already-reviewed patients they had never
uploaded reads as invented history, and this project's whole claim is that the
model's grade and the doctor's grade are both real and both preserved. The
pre-graded cases live on the demo account, which is what the report and the live
demo sign in as. A registered account starts where a real doctor starts.

Say in the report that a system a hospital actually ran would provision accounts
rather than let the internet join. Open sign-up is right for a demo and wrong for
a clinic, and knowing the difference is the point.

The Default / CAM / CCEM control only offers a method the case actually has a map
for – a tab that silently rendered a different method's picture would make the
explainability claim untrue in the one place a judge will click.

The mockups are dark, and dark is the default on a first visit whatever the
operating system is set to – bright chrome around a dark fundus photograph wrecks
contrast judgement. Light is a preference a doctor can pick, and it is remembered.

---

## What a marker can run in five minutes

```bash
# BR-1 – another doctor's case is invisible, not forbidden
curl -i -b ha.txt $API/api/cases/<one of Quang's case ids>     # 404

# BR-3 – a disagreement with no reason is refused
curl -i -b quang.txt -X POST $API/api/cases/<id>/mark \
     -H 'Content-Type: application/json' \
     -d '{"agreement":"DISAGREE","correctedGrade":3}'          # 400

# BR-4 – the model's grade survives the correction
sqlite3 server/data/retinax.db \
  "SELECT c.CorrectedGrade, p.Grade FROM cases c JOIN predictions p
     ON p.CaseID = c.CaseID WHERE c.Agreement='DISAGREE';"     # differ
```
