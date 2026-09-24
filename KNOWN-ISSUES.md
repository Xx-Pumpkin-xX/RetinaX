# Known issues

Open items first, then what has been resolved.

---

## Open

### The lesion marks have never been checked by eye
The six lesion models report counts and the case screen draws marks, but nobody
has opened a graded case and confirmed a mark sits on the lesion it names. Until
someone does, the positions are unverified — the numbers are the claim, the
drawing is decoration. NV in particular is shown as "not assessed" rather than
"0" because its recall is not credible.

### The tunnel is a single point of failure
A cloudflared quick tunnel fronts the API and hands out a new hostname every
time it restarts. Until `API_ORIGIN` in Pages is updated and the deployment
retried, the site is up and cannot reach its API — which looks like the API
being down. A named tunnel would fix the hostname; it needs a domain.

### The demo account's password is public
`DEMO_EMAILS` exempts it from email confirmation and device approval, and the
landing page fills the password in. That is the point of a demo account, and
BR-1 keeps it to its own cases, but it is the weakest door in the system and
the report should say so rather than let a judge find it.

### The vault has no off-machine backup
Everything under `VAR_DIR` is encrypted and snapshotted, but every copy lives on
prts-0. Losing that disk loses the lot. A nightly copy elsewhere is cheap and
has not been set up.

## Resolved

### Signing out did not actually end the session
*Fixed 24 Sep 2026.*

Sign-out removed the cookie from the browser and nothing else, so the JWT inside
it stayed valid until its own expiry — up to 14 days. A token copied out
beforehand kept working. Sessions now carry an id, sign-out records that id in
`revoked_sessions`, and `auth` refuses it on every request; the row is dropped
once the token would have expired anyway, so the table does not grow. Sign-out
also ends the browser's 30-day device trust, so signing in again from it needs a
fresh email approval.

Tokens issued before this change have no id and cannot be revoked. They expire
within a fortnight on their own.

### A patient code could carry the same eye twice
*Fixed 24 Sep 2026.*

Nothing stopped two cases sharing a patient code and an eye, so one eye could
end up with two grades and no way to tell which the clinician meant. Patient
code and birth year are now both required, the eye must be OD or OS, and a
second image of an eye already on file is refused with 409 `DUPLICATE_EYE`.
`FAILED` rows are exempt, so retrying an eye whose grading failed still works.

New Case also stopped abandoning good work: when one eye passes the fundus gate
and the other is refused, the page stays put with the accepted eye saved, and
only the refused slot is re-sent. A refused image is never graded.

### A signed-out session still showed a name in other tabs
*Fixed 24 Sep 2026.*

Signing out in one tab left every other tab showing the doctor's name until its
next click failed. The API now announces a 401, sign-out broadcasts to the other
tabs, and returning to a tab re-checks the session — all three land on the
sign-in screen. Where the doctor was going is remembered, so an expired session
resumes there instead of dumping them on the worklist.

### Sign-up

*Built 8 Sep 2026.* Open sign-up, as decided — anyone can create an account for
the showcase. Safe because of BR-1: a new account sees only its own work.

Rejected: weak passwords, malformed emails, duplicate addresses (409). Accepted:
the account is signed in immediately, and seeded with **its own copies** of the
demo cases so a judge does not land on an empty worklist. Verified both
directions — each account 404s on the other's case IDs.

Seeding runs in the background, so the worklist now polls while any case is
`PROCESSING`. Without it a new user saw one row saying "Grading…" that never
changed until they refreshed.

The report should say plainly that open sign-up is a **demo decision** — a
hospital would provision accounts, not let the internet join.


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
