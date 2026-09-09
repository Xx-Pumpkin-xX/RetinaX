# Techniques and engineering decisions
## RetinaX.ai — what was used, and why it was used

Written for the project report and for anyone who has to defend this system in
a viva. It is organised by layer, and every entry says *why*, because "we used
JWT" is not an answer and "we used JWT in an httpOnly cookie because a token in
localStorage is readable by any script on the page" is.

The last two sections are the most useful ones: the bugs that taught something,
and what we would do differently.

---

## 1 · The stack

```
web/      React 18 · Vite · react-router-dom          → Cloudflare Pages
server/   Node 22 · Express 4 · node:sqlite           → a storage host, always on
ai/       Python · FastAPI · PyTorch · timm           → a GPU host, shared
```

Three processes on three machines, chosen so that losing the least reliable one
degrades the system rather than stopping it. Section 5 covers that.

---

## 2 · Front end

### 2.1 A single-page application, and what that costs

React with `react-router-dom`. Routing happens in the browser: `/cases/abc` is
not a file on any server, so a static host asked for it returns 404. Fixed with
a rewrite rule — `web/public/_redirects` sends every unknown path to
`index.html` and lets the router take over.

This is the single most common way an SPA breaks in production, and it only
appears when someone reloads a deep link rather than clicking to it.

### 2.2 Build-time versus run-time configuration

`VITE_API_URL` is read by Vite **at build time** and compiled into the bundle.
Setting it in a hosting dashboard does nothing to a build that already happened.

This produced a failure that looks exactly like "the API is down": the variable
is visibly correct in the dashboard, and the deployed JavaScript still contains
the old value. The fix is to redeploy, and the lesson is that a "configuration"
variable in a front-end build is not configuration at all — it is source code.

### 2.3 Theming with CSS custom properties

One set of tokens on `:root`, redefined under `[data-theme="dark"]`. A small
script in `<head>` sets the attribute before first paint, so there is no flash
of the wrong theme. The preference is stored in `localStorage`.

Dark is the default. Not a style choice: bright interface chrome around a dark
fundus photograph destroys the contrast judgement the clinician is there to
make.

Four colour roles that never borrow from each other — accent (actions),
severity `--g0`–`--g4` (DR grade only), danger (errors), notice (the standing
disclaimer). Keeping severity out of the general palette means a grade colour
always means a grade.

### 2.4 Scoping an imported stylesheet

The landing page came from a separate build whose CSS defined `--surface`,
`--line`, `--muted` and `--text` on `:root` — four names the application was
already using. Importing it would have repainted the whole app.

Every selector and variable was scoped under `.rx-landing`, with a reset in
both directions. The general technique: when merging two codebases, the
collision to look for is not duplicate class names but duplicate *custom
property* names, because those cascade and are invisible in a diff.

### 2.5 Fetching images instead of `<img src>`

The obvious way to show a protected image is `<img src="/api/cases/1/image">`.
It was replaced with a component that `fetch`es the bytes and renders from an
object URL (`URL.createObjectURL`), revoked on unmount.

Three reasons, discovered in this order:

1. `<img>` cannot send request headers, and the tunnel in front of the API
   needed one.
2. `<img>` cannot report a *useful* error. A 200 that is not an image renders
   as a broken picture; a fetch can check `Content-Type` and say so.
3. A browser sniffs content and will display an image served with the wrong
   type — which hides a server bug until something stricter comes along.

The cost is that images are no longer cached by the browser as URLs, and both
ends now send `no-store` deliberately (§9.4).

### 2.6 Client-side filtering, and where the grouping happens

The worklist filters in the browser rather than through the API, because a
clinician's list is tens to hundreds of rows, not thousands. Rows are filtered
per eye and *then* grouped by patient, so a status filter can legitimately show
one eye of a patient — correct, and worth a comment in the code so it is not
"fixed" later.

The `referableOnly` filter reads the doctor's corrected grade where one exists,
falling back to the model's. Grade ≥ 2 is the referral threshold in screening
guidelines, so this is a clinical filter, not a convenience.

---

## 3 · Back end

### 3.1 `node:sqlite`, and dropping a native dependency

Originally `better-sqlite3`. It failed to build on a recent Node because no
prebuilt binary existed, and building it needs a C++ toolchain — on Windows,
Visual Studio. That is a hostile first experience for a teammate cloning the
repository.

Node 22.5 ships `node:sqlite` in core, with a nearly identical synchronous API.
The driver is selected at startup, preferring the built-in and falling back to
the native module if present:

```js
try   { const { DatabaseSync } = await import("node:sqlite"); ... }
catch { const { default: Database } = await import("better-sqlite3"); ... }
```

Verified by deleting `better-sqlite3` from `node_modules` and running the whole
stack. The general point: a native dependency is a tax paid by every person who
clones the repository, and it is worth real effort to remove one.

### 3.2 Synchronous database calls in an async server

`node:sqlite` is synchronous. In a request handler that is normally a warning
sign, but here the alternative is worse: this is a single-writer application
with a local file, and every query is sub-millisecond. Making them async would
add complexity and a class of interleaving bugs to buy nothing.

Worth stating explicitly because a marker will notice `db.prepare(...).get()`
in an `async` handler and should hear a reason, not a shrug.

### 3.3 Ownership in the query, not after it

Every case route calls one helper:

```sql
SELECT ... FROM cases c LEFT JOIN predictions p ON p.CaseID = c.CaseID
 WHERE c.CaseID = ? AND c.DoctorID = ?
```

The ownership check is in the `WHERE` clause. A row belonging to another doctor
never leaves the database, so there is no moment at which the code holds data it
should not, and no post-fetch check anyone can forget to write.

This is the difference between "we check permissions" and "unauthorised data
does not exist in this process".

### 3.4 File uploads

`multer` with `diskStorage`, a 12 MB cap and a MIME allowlist. `diskStorage`
rather than the simpler `dest` option, purely to keep the file extension —
`dest` writes a random name with none, and then the download route cannot infer
a content type (§9.3).

Uploads are **not** served statically. There is no `express.static` over the
upload directory; the only way to an image is an authenticated, ownership-checked
route. Verified by requesting a real filename directly: 404.

### 3.5 Long work does not belong in a request

Grading is a few seconds and happens inside the upload request, with a 45-second
timeout so an unreachable model cannot hold the connection open.

CCEM is *minutes* — three explainers, one of which runs hundreds of masked
forward passes. It is a separate endpoint the doctor triggers, with its own
much longer timeout. Putting it in the upload path would make every clinician
wait for an explanation most of them will never open.

The general rule: the acceptable latency of a request is set by the person
waiting for it, not by the work.

### 3.6 Schema changes on a database that already has data

`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
new column never reaches a deployed database. A small helper checks
`PRAGMA table_info` and issues `ALTER TABLE` only when the column is missing:

```js
function ensureColumn(table, column, declaration) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
```

Checked against the catalogue rather than attempted-and-caught, so a genuine
failure is still an error instead of being swallowed.

### 3.7 Append-only history beside mutable current values

Reviews are the one place the system refuses to forget. The `cases` row holds
the *current* assessment, so every existing reader keeps working; a `reviews`
table receives an immutable row per submission.

Amend freely, lose nothing. And crucially the model's grade lives in a third
table, `predictions`, written once — the human answer and the machine answer
cannot overwrite each other because they are not in the same place.

### 3.8 Idempotent seeding

The deployed demo re-seeds itself at boot when empty. Seeding asks the live
model first and falls back to answers committed in the repository, so the
worklist is populated even when the GPU host is unreachable. Seeding is keyed
per doctor, not globally — a global "are there any cases?" check silently stops
seeding the demo account the moment anyone signs up.

---

## 4 · The model service

### 4.1 An adapter, not an import

`ai/dr_adapter.py` is the only file that knows the research repository exists.
`ai/main.py` knows the HTTP contract and nothing else. The research code is
reached by putting its directories on `sys.path` and importing, so there is no
copy of it to drift.

The exception is deliberate: the preprocessing transform is *rebuilt* rather
than imported, because the training repo's `augmentation.py` does not parse — a
stray token on line 5. The validation transform is three lines; reimplementing
those beats importing a broken module.

### 4.2 Serving must reproduce training exactly

```
BGR → RGB → crop_image_from_gray → apply_clahe → Resize(600) → Normalize → ToTensor
```

Skip the crop or the CLAHE and the model still returns a plausible number, the
interface still shows a grade, and it is wrong. Nothing looks broken. The
functions are imported from the research repo rather than reimplemented, so
they cannot drift.

### 4.3 Test-time augmentation, because the thresholds assume it

Validation averaged three views (original, horizontal flip, vertical flip), and
the decision thresholds were fitted on those averaged scores. Serving a single
pass would shift the score distribution slightly and quietly mis-calibrate every
threshold. Serving matches training, and `USE_TTA` documents why.

### 4.4 The thresholds are not in the checkpoint

The model is a **regression** head: one continuous score. Four Nelder-Mead cut
points, fitted after training by `OptimizedRounder` and saved separately as
`best_thresholds.npy`, turn that score into a grade.

```
fitted   [0.565, 1.441, 2.375, 3.042]
default  [0.5,   1.5,   2.5,   3.5  ]
```

A score of 3.2 grades as 4 with the fitted values and 3 with the defaults —
the severe-NPDR / PDR boundary, which is the referral decision. Loading the
wrong file breaks nothing visibly, so `/health` reports `thresholds_source` and
the launcher refuses to start if the file is missing. **Make silent
miscalibration loud.**

### 4.5 Degrading instead of failing

`run_resilient()` catches CUDA out-of-memory, moves the model to CPU and retries
once, staying there for the process lifetime rather than thrashing. The GPU is
shared; another user's training run can take the memory at any moment. Answering
slowly beats answering with a 500.

### 4.6 Explanation maps

Grad-CAM++ on every case (one backward pass). CCEM on request — a fusion of
Grad-CAM++, Ada-SISE and SmoothIG weighted by adaptive reliability.

Rendering matters as much as computing:

- **The map is drawn where it was computed.** Preprocessing crops the black
  border off, so the activation describes the *cropped* retina. Resizing it to
  the original frame stretches it over the border too. Measured error on
  off-centre hotspots: **85–135 px, with 23–100 % of the activation falling
  outside the eye.** A centred hotspot lands correctly either way, which is why
  it survived so long. The map is now pasted at the crop's offset on a
  transparent canvas.
- **The palette is jet**, matching the paper's figures, so a reader comparing
  the two does not have to translate between colour schemes.
- **The photograph is blended in** at render time (~0.45), not laid under an
  opaque layer. An opaque overlay at full strength does not merely hide the
  retina — measured against the original, it *inverts* its structure
  (correlation −0.12).

---

## 5 · Deployment and networking

### 5.1 Three hosts, chosen for failure isolation

```
browser → Cloudflare Pages → storage host → (private) → GPU host
```

With the GPU host down: sign-in, the worklist, every existing case and both
explanation maps work normally. Only *new* grading fails, and it fails visibly —
the case is marked failed and offers to retry, rather than presenting a defaulted
grade as if the model had produced it.

That property was not theoretical. The shared GPU machine was unavailable for a
full day during the build.

### 5.2 A reverse proxy to keep the session cookie first-party

The front end and API were on different sites (`pages.dev` and a tunnel
hostname), which made the session cookie a **third-party cookie**. Safari blocks
those outright, Firefox by default, Chrome in incognito.

A Cloudflare Pages Function now proxies `/api/*` to the API host, so the browser
only ever sees one origin. Consequences: the cookie is first-party, CORS stops
applying, and the tunnel's browser interstitial cannot fire. The request body is
streamed rather than buffered, so a 12 MB upload still passes through.

### 5.3 Private networking rather than a public tunnel

The inference service has no authentication of its own, so it must not be on the
open internet. Tailscale gives the two hosts stable private addresses
(`100.x.y.z`) with no port forwarding.

Tailscale needs root to install — which we did not have on the shared GPU host —
so it runs there in **userspace networking mode** from a tarball in the home
directory (`tailscaled --tun=userspace-networking`), the same mode used inside
containers. An SSH `-L` tunnel is documented as the alternative when even that
is not possible.

### 5.4 Processes that survive a disconnect

`tmux` for both services, so closing a browser tab or an SSH session does not
kill them. The launcher scripts wait for a real readiness signal — `model_loaded:
true`, and the API answering — rather than reporting success the moment `tmux`
exists.

### 5.5 Ephemeral filesystems

Free web hosts wipe the disk on every deploy, restart and idle spin-down. Two
responses: demo answers are **committed to the repository** so the deployed demo
is always populated, and a single `VAR_DIR` groups the database and the images
so one persistent mount covers both. Mounting only the database directory would
keep every row and lose every photograph — a worklist of broken images, which
reads as a bug rather than a documented trade-off.

---

## 6 · Security

| Technique | Why |
|---|---|
| bcrypt for passwords | Slow by design; a leaked table is not a password list |
| JWT in an `httpOnly` cookie | A token in `localStorage` is readable by any script on the page |
| `SameSite=None; Secure` cross-site, `Lax` locally | The only combination a browser accepts cross-site |
| **404, not 403,** for another doctor's case | `403` confirms the case exists and belongs to someone else |
| Reset tokens stored as **SHA-256 hashes** with a 30-minute expiry | A stolen database must not yield working reset links |
| Identical reply whether or not an address is registered | A different reply enumerates accounts |
| No static serving of uploads | The only path to an image is authenticated and ownership-checked |
| `rel="noopener"` on `target="_blank"` | Otherwise the opened page gets a handle on this one via `window.opener` |
| Model reachable only on the private network | `/infer` has no authentication of its own |
| No patient names — code and birth year only | Holding less means a breach costs less |

Two rules learned the hard way, both in §9.

---

## 7 · Verifying by attacking, not by reading

Every business rule was checked by trying to break it, and the transcript of the
attempt is the evidence — not a claim in a document.

```
BR-1  second account issued one of the first account's case IDs
      → 404 on the case, the image, both heatmaps, mark, regrade, explain, delete
      → worklist returned []
BR-2  marking a FAILED case                        → 409
BR-3  disagreement with an empty reason            → 400
BR-4  three amendments AGREE → DISAGREE 4 → AGREE
      → predictions.Grade stayed 2 throughout, all three retained
      static path to a real upload filename        → 404
      path traversal through the case route        → 404
```

The same method found the overlay misalignment: rather than looking at a picture
and deciding it seemed fine, a synthetic fundus with a known hotspot position
was rendered both ways and the error measured in pixels.

---

## 8 · Version control

Conventional Commits (`feat:`, `fix:`, `chore:`) with a body explaining *why*,
since the diff already shows what.

Two lessons:

- **`git add -A` swept in 37 MB of non-source files** — dataset images, a
  Windows installer, an output folder, and two photographs uploaded to the
  running system. `.gitignore` only applies to files that are *not already
  tracked*, so a rule added later does not remove anything.
- **Removing them from `HEAD` does not remove them from history.** A clone still
  pays. `git filter-repo --invert-paths` rewrites every commit that touched
  them; it keeps the commits and their messages, changes every hash, and needs a
  force-push and a fresh clone for everyone else.

---

## 9 · Bugs that taught something

The most useful section for a viva. Each of these looked like something else
first.

### 9.1 A browser will not let a non-Secure cookie overwrite a Secure one

Signing out appeared to work; a reload put you straight back in.
`res.clearCookie("rx")` with no options sends a `Set-Cookie` **without**
`Secure`, and the rule — which exists so a network attacker on a plain-HTTP page
cannot tamper with cookies an HTTPS site set — means the clear was silently
discarded.

Clearing a cookie must repeat every attribute used to set it. Both now come from
one function so they cannot drift.

### 9.2 A third-party cookie is dropped without an error

Login *succeeded* — the response carried the doctor's name, so the interface drew
it — and every request after that was 401, because the cookie was never stored.
The symptom is a UI that says you are signed in while the API says you are not.

Fixed by proxying the API through the site's own origin (§5.2). Found only by
testing in an incognito window; it would have appeared first on a judge's iPhone.

### 9.3 A 200 that is not what you asked for

`multer`'s `dest` mode writes files with no extension, so `res.sendFile` could
not infer a type and answered `application/octet-stream`. A browser sniffs that
and shows the image anyway — so a bare `<img>` never revealed it. A `fetch` that
checks the content type refused it, correctly, and the photograph vanished while
the heatmap beside it still rendered.

Two fixes: keep the extension on new uploads, and set `Content-Type` from the
file's **magic bytes** rather than its name, which also repaired every row
already stored.

### 9.4 A cached response outlives the bug it came from

After the content-type fix the picture was still broken. The browser had cached
the earlier bad response; Express sends an `ETag`, so it revalidated, got a 304,
and reused the stored headers — including the wrong content type. **A fix can be
correct and invisible.** Both ends now send `no-store` for case images.

### 9.5 A rendered file does not repaint itself

Changing the heatmap renderer changed nothing on screen, twice, because stored
heatmaps are PNG files produced at upload time. From the browser a stale service
and a stale picture are indistinguishable.

Two responses: a **Redraw overlay** action that re-renders without recomputing
the grade, and `heatmap_style` reported in `/health` so "did the new renderer
deploy" is answerable from outside the process.

### 9.6 Deleting a case is a design decision, not a feature

A failed case is litter — no grade, no explanation, no assessment. A **reviewed**
case is a clinician's recorded judgement, and the disagreement it records is what
this project argues for preserving. Deletion is offered for the first and refused
with a reason for the second.

### 9.7 A feature that lies is worse than one that is missing

Password reset was mechanically perfect — single-use tokens, hashed, expiring —
and sent no email; the link went to a log file while the screen said "a reset
link is on its way". The fix was half a mail sender and half **telling the truth
when there is no provider configured.**

### 9.8 Line endings, and tooling that disagrees with itself

Editing the repository from a Linux environment while working on Windows made
every file appear modified — `core.autocrlf` differs, so each side saw the
other's checkout as a full rewrite. Zero files differed by anything other than
whitespace. The lesson is to check `git diff --ignore-all-space` before believing
a diff, and to make one machine the authority.

---

## 10 · What we would do differently

1. **Assess image quality before grading.** The system grades a defocused
   photograph without complaint. This is the most clinically significant gap.
2. **Postgres and object storage from the start** if more than one clinician
   writes concurrently. SQLite was right for this, and the boundary is visible.
3. **A token denylist**, so signing out revokes the session everywhere rather
   than only removing the cookie from one browser.
4. **Test in a third-party-cookie-blocking context on day one.** That class of
   bug is invisible in a normal development browser.
5. **Never `git add -A`.** Name the files.
6. **Decide where a file's canonical copy lives** before two machines start
   editing it.
