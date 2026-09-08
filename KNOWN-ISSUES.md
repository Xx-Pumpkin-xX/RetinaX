# Known issues

Open items first, then what has been resolved.

---

## Open

### 1 · Sign-up is not built yet

The mockup shows a **Sign up** tab and there is no route behind it. Decided: it
should be **open sign-up** — anyone can create an account for the showcase. BR-1
already isolates accounts (a doctor sees only their own cases, and another
doctor's case returns 404), so a new account sees nothing but its own work.

Two things it needs beyond the route itself:

- each new account seeded with its own copy of the demo cases, so a judge who
  signs up does not land on an empty worklist;
- the report should say plainly that open sign-up is a **demo decision**. In a
  real deployment accounts are provisioned by the clinic — a screening tool that
  anyone can join is not one a hospital would run.

**Files:** `server/server.js` (a `POST /api/signup`), `server/seed-demo.js`
(seed per doctor rather than per database), `web/src/pages/Login.jsx`.

---

## Resolved

### One case is one eye — you could not record both eyes together
*Raised 8 Sep 2026, fixed the same day.*

New Case took one photograph and one eye, so screening a patient meant filling
the form twice and getting two unrelated worklist rows that happened to share a
patient code.

**What was decided.** A case stays one eye. That is clinically right — DR is
graded per eye — and it keeps the class diagram true, which matters three days
from a deadline. What was wrong was the entry and the display, not the model.

**What changed.** New Case now has two photograph slots, Right (OD) and Left
(OS), with the patient details typed once; each photograph becomes its own case,
posted separately, so `POST /api/cases` and UC-2 are untouched. One eye failing
to grade no longer discards the other — the error is reported against that eye
and the other is still saved. The worklist groups a patient's eyes together and
shows the **worse eye** grade on the first row, using the doctor's corrected
grade where one exists and the model's otherwise, because the referral decision
follows the worse eye.

**What was deliberately not done.** Turning a case into a *visit* holding two
images would be cleaner, and would mean splitting `Case`, moving `Prediction`
onto the image, and redrawing both UML diagrams. That belongs in the report as
future work, not in the last three days.

### CAM and CCEM showed the identical image
*Fixed 8 Sep 2026.*

One `HeatmapPath` column and one `/heatmap` endpoint meant the overlay toggle
changed the label and nothing else — on the one screen where the explainability
claim is tested. `predictions` now holds `HeatmapCamPath` and `HeatmapCcemPath`,
the API serves `/heatmap/cam` and `/heatmap/ccem`, and the control only offers a
method the case actually has a map for.
