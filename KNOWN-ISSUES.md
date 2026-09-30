# Known issues

Open items first, then what has been resolved.

---

## Open

### The lesion marks are eyeballed, not measured
*Checked 24 Sep 2026.* Opened a graded case and confirmed the marks land on the
lesions they name — so the drawing is not decoration, which is what was in doubt.

That is one pair of eyes on a handful of cases, not a measurement. No
localisation metric has been computed against ground-truth masks, so the honest
claim is "the overlay is consistent with the finding", not "the positions are
accurate to within X". NV is still shown as "not assessed" rather than "0",
because its recall is not credible whatever the marks look like.

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

### A single request could take the whole API down
*Fixed 29 Sep 2026.*

`POST /api/login` passed the request's `password` straight to bcryptjs, which
throws `Illegal arguments` on anything that is not a string. The throw happened
inside an `async` handler, Express 4 does not await those, and Node ends the
process on an unhandled rejection. So one anonymous request carrying
`"password": true` — no account, no credentials, one edited line in the browser's
network tab — stopped the service for everybody, with no log line explaining it
because the process was already gone.

Found by the team testing its own product adversarially. Fixed in three
independent layers, because one of them will eventually be wrong:

- the route rejects a non-string email or password with 400 before bcrypt sees it
- `unhandledRejection` and `uncaughtException` log a stack and keep serving
- `run-on-host.sh` runs node in a respawn loop, so a process that dies anyway is
  back in two seconds and writes a `[respawn]` line saying so

An audit of every other `req.body` read found no second instance: the rest of
the codebase already coerced with `String(...)`, checked against a whitelist, or
tested `Array.isArray` first. Login was the one omission, in the one route that
does not require an account.

### The API would start happily on a closed vault
*Fixed 29 Sep 2026.*

`run-on-host.sh` created `VAR_DIR` if it was missing. With the vault unmounted
that is an ordinary empty directory, so the API started on a brand-new empty
database and wrote plaintext photographs into the mountpoint, where they are
hidden the moment the vault is mounted over them — and `/api/health` reported
`database ok` throughout. It refuses to start now unless `$VAR_DIR/.vault-open`
exists or `VAR_DIR` is a mount point. The documentation had claimed this guard
existed for some time before the code did.

### Signing up told people to sign in before confirming
*Fixed 30 Sep 2026.*

The message after sign-up read "Sign in to confirm this browser and continue",
so people went to the sign-in form — where they were refused with 403 until the
address was confirmed, and only then thought to open the email. It now names the
address and says to open the link first.

Confirming an address also trusts the browser that opened the link, so signing
up costs one email and one click rather than two. Both steps prove the same
fact: that this person reads that mailbox.

### Sign-out: what it ends, and why
*Settled 30 Sep 2026.*

Briefly, on 29 Sep, sign-out was changed to end the session but leave the
browser trusted — the argument being that a doctor who signs out nightly should
not wait for a mail each morning, because that teaches people to click approval
links without reading them.

That was reverted the next day, deliberately. The second step exists to prove
the person holds the mailbox, and an explicit sign-out is exactly the moment to
ask for that proof again; two-step verification that survives signing out is not
really two-step. A shared or borrowed machine left trusted for thirty days after
the doctor thought they had left is the thing being prevented. The daily-email
cost is accepted, and it is the reason "keep me signed in" exists.

### The confirmation link opened the password reset form
*Fixed 29 Sep 2026.*

The sign-in screen chose its view by asking only whether the URL carried a
token, so `/verify?token=…` — the address-confirmation link — fell through to
the reset form. `api.verifyEmail` existed and nothing called it. Signing up had
therefore never worked end to end; it was invisible because the demo account is
exempt from confirmation, and that is the account everything was tested with.

### A password reset left the old sessions alive
*Fixed 29 Sep 2026.*

Changing a password changed only the password: existing tokens stayed valid for
up to fourteen days and every trusted browser stayed trusted. Someone resetting
because they think their password leaked was not removing the thief. Sessions now
carry the doctor's `TokenEpoch`, a reset increments it, and `auth` refuses any
token from an earlier generation; the trusted browsers are dropped with it.

### Year of birth and sex belonged to the photograph, not the patient
*Fixed 29 Sep 2026.*

Nothing tied the rows sharing a patient code together, so one eye could be filed
as born 1968, F and the other as 1972, M for the same person. The first case
under a code now fixes the patient: a later upload that disagrees is refused with
`PATIENT_MISMATCH`, and correcting the details on one eye writes them to the
others, which the form says before it saves.

### Agreeing with a grade hid the explanation
*Fixed 29 Sep 2026.*

The review route returned the lean worklist shape, so the case screen replaced
what it was showing with a row carrying no regions, no lesions and no image size.
Pressing Agree made the overlays and the lesion chips vanish until a reload.


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
