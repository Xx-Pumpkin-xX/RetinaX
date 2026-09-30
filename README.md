# RetinaX.ai

Diabetic retinopathy screening support for ophthalmologists. A doctor uploads a
fundus photograph, a grading model returns a DR grade (0–4) and an explanation
heatmap, and the doctor agrees with it or overrides it. **The doctor's answer is
the diagnosis of record — the model never overwrites it, and the model's own
grade is never overwritten either.** Both are kept, side by side, forever.

That last sentence is the whole product. Everything below serves it.

<!-- Replace with a screenshot of the case-detail screen once deployed. -->

---

## What it is not

It is not a diagnostic device. Every screen where the model has a voice carries
the same line: *decision support only, the AI can be wrong, every grade must be
confirmed by a clinician before it is used.* No patient names are stored — only
a patient code and a birth year. All images used in development come from the
public APTOS 2019 / EyePACS datasets.

---

## The two halves of the front end

`/` is a **public landing page** — hero, about, features, workflow, research
figures, affiliations. It came from the team's first demo and carries its own
light palette, scoped entirely under `.rx-landing` so it cannot reach the themed
application. Everything else requires a session and redirects to `/login`.

That split is deliberate: the landing is marketing and answers to nobody but the
reader; the application behind it answers to the class diagram and the four
business rules.

## Architecture

Three processes, deliberately.

```
web/      React 18 + Vite            the doctor's screens
server/   Express + SQLite           accounts, cases, business rules
ai/       FastAPI + PyTorch          the grading model (.pth), CAM / CCEM
```

The model lives behind its own HTTP service rather than inside the API. Two
reasons: it is a Python model and the API is Node, and the regression score and
the Nelder-Mead optimised thresholds must stay *inside* the model. The service
returns a grade and explanation maps. Nothing else leaves it.

**Two maps, not one.** Grad-CAM++ is a single backward pass, cheap enough to run
on upload. CCEM fuses Grad-CAM++, Ada-SISE and SmoothIG — hundreds of passes,
minutes rather than seconds — so it is produced by a batch run and can be absent
on a freshly uploaded case. The case screen offers only the methods that case
actually has, because a tab that quietly showed a different method's picture
would make the whole explainability claim untrue.

### Data model — eight tables, four of them the domain

| Table | What it holds |
|---|---|
| `doctors` | account, bcrypt password hash, email-confirmation and reset token hashes |
| `cases` | patient code, birth year, sex, eye, the image, status, and the current assessment |
| `predictions` | the model's grade, its explanation maps, attention regions and lesion maps — **write-once** |
| `reviews` | the assessment **history** — an amendment appends, never overwrites |
| `trusted_devices` · `login_verifications` · `revoked_sessions` · `auth_attempts` | sessions and rate limiting. Every token is stored as a SHA-256 hash and every row expires |

`cases` keeps the *current* assessment alongside `reviews` on purpose: the
worklist is then one query. `reviews` is the record of how it got there.

`predictions.Grade` is never updated. A doctor who disagrees writes
`cases.CorrectedGrade` and `cases.Reason`; the model's grade stays visible next
to it. Disagreements are the training signal for the next model version.

### The eight business rules the code actually enforces

| | Rule | Where |
|---|---|---|
| BR-1 | A doctor can only reach their own cases. Another doctor's case returns **404, not 403** — 403 would confirm it exists. | `ownCase()` in `server/server.js` |
| BR-2 | A case can only be marked once it has been graded (`409` otherwise). | `/api/cases/:id/mark` |
| BR-3 | Disagreeing requires **both** a grade 0–4 **and** a written reason (`400` otherwise). | `/api/cases/:id/mark` |
| BR-4 | The doctor's correction never touches `predictions.Grade`. | the `UPDATE` only names `cases` columns |
| BR-5 | One image per eye per patient code (`409 DUPLICATE_EYE`). | `eyeTaken()` |
| BR-6 | Year of birth and sex describe the patient, not the photograph (`409 PATIENT_MISMATCH`). | `patientIdentity()` |
| BR-7 | A reviewed case cannot be deleted without an explicit confirmation (`428`). | `DELETE /api/cases/:id` |
| BR-8 | The assistant has no write path — neither chat route touches SQL. | `server/chat.js`, `ai/main.py` |

---

## Running it locally

**`SETUP.md` is the step-by-step guide, written for Windows.** The short version,
three terminals:

```bash
# 1 — the grading service
cd ai
pip install -r requirements.txt
uvicorn main:app --port 8000

# 2 — the API
cd server
npm install
copy .env.example .env    # set JWT_SECRET; cp on macOS/Linux
npm run seed              # creates two demo doctors
npm run dev               # http://localhost:3000

# 3 — the front end
cd web
npm install
npm run dev           # http://localhost:5173
```

Sign in as `quang@retinax.ai` / `retinax123` (or `ha@retinax.ai`, same password).

### Wiring in the real model

`ai/main.py` ships with a working stand-in so the stack runs end to end before
the weights are in place. Put `model.pth` in `ai/`, then fill in the two marked
blocks:

```python
def load_model():   # TODO: torch.load your .pth, .eval(), return it
def predict(img):   # TODO: your transform, forward pass, CAM / CCEM
```

`THRESHOLDS = [0.57, 1.48, 2.51, 3.42]` are the Nelder-Mead cut points that turn
the regression output into a grade. Replace them with yours. `/health` reports
`model_loaded` so you can see at a glance whether the real weights are live.

---

## Deployment

**[DEPLOY.md](DEPLOY.md) is the runbook. Read its first section before running
anything** — every command is labelled with the machine it belongs on, and most
mistakes on this project have been the right command on the wrong machine.

The shape, in one table:

| Machine | Runs | Deployed by |
|---|---|---|
| **`prts`** (your Windows PC) | git, the source of truth | nothing serves here |
| **Cloudflare Pages** | the React front end, `retinax.pages.dev` | automatically, on every push to `main` |
| **`prts-0`** (always-on Linux) | the API `:3000`, SQLite, the uploaded images | `tools/build-server-tar.sh` → upload → unpack |
| **`spark-063e`** (DGX Spark) | the grading model `:8000`, the `.pth`, the GPU | rarely; only when `ai/` changes |

A request goes: browser → Pages → a Pages Function proxying `/api/*` → the tunnel
→ `prts-0` → (only on upload) the Spark, over Tailscale.

Three things that are load-bearing and non-obvious:

- **The `/api/*` proxy is not an optimisation.** Without it the page and the API
  are on different origins, so the session cookie is third-party — blocked by
  Safari always, Firefox by default, Chrome in incognito. Login appears to
  succeed (the name came back in the body) and every later request is 401.
- **`VITE_API_URL` must stay unset in Pages.** `src/api.js` falls back to `""`,
  which makes calls same-origin so the proxy picks them up. Setting it bypasses
  the proxy and brings the cookie bug back. `API_ORIGIN` is the variable that
  matters, and it points at the tunnel in front of `prts-0`.
- **The data lives only on `prts-0`.** The database and every uploaded image are
  under `$VAR_DIR` there. The deploy tar deliberately excludes them, so unpacking
  over a running install cannot destroy them — the build script checks the packed
  archive rather than trusting its own exclude list.

This replaced an earlier Render deployment, whose free instance wiped its disk on
every restart and took the uploads with it. Do not put the API back on a host
with ephemeral storage.

`server/demo-images/` **is** committed on purpose — it is the only thing a fresh
instance can re-seed itself from, so it must hold public-dataset images and never
real patient photographs. `.gitignore` keeps `node_modules/`, the database, the
uploads, the `.pth`, every `.env` and the deploy tars out of the repo.

---

## API

All routes require the session cookie except login and the password-reset pair.

| Method | Route | |
|---|---|---|
| `POST` | `/api/signup` | `{fullName, email, password}` — sends a confirmation link |
| `GET` | `/api/email/verify` | confirms the address **and** trusts that browser |
| `POST` | `/api/email/resend` | same answer whether or not the address exists |
| `POST` | `/api/login` | `{email, password, keepSignedIn}` — 403 until confirmed |
| `GET` | `/api/login/verify` | approves a sign-in from an unrecognised browser |
| `POST` | `/api/logout` | ends the session **and** this browser's trust |
| `GET` | `/api/me` | |
| `POST` | `/api/password/forgot` | always returns `{ok:true}` — see below |
| `POST` | `/api/password/reset` | `{token, password}` — retires every existing session |
| `GET` | `/api/cases` | the signed-in doctor's cases only |
| `POST` | `/api/cases` | multipart: image + patient fields; grades on upload |
| `GET` | `/api/cases/:id` | |
| `DELETE` | `/api/cases/:id` | 428 + confirmation when the case is reviewed |
| `POST` | `/api/cases/:id/mark` | `{agreement, correctedGrade?, reason?}` |
| `POST` | `/api/cases/:id/details` | corrects patient details across that patient's eyes |
| `POST` | `/api/cases/:id/regrade` · `/explain` | re-runs the model or redraws the map; never writes `Grade` |
| `POST` | `/api/cases/:id/chat` | discuss the case with the assistant — **writes nothing** |
| `POST` | `/api/chat` | help with using the application |
| `GET` | `/api/cases/:id/image` · `/heatmap/:method` | |
| `GET` | `/api/health` | build, database, model, assistant, mail |

**Password reset.** The token is random, single-use and expires in 30 minutes.
Only its SHA-256 hash is stored, so a leaked database cannot be turned back into
working reset links. `/api/password/forgot` answers identically whether or not
the address has an account — a different answer would tell an attacker which
doctors are registered. Mail goes out through the Gmail API with OAuth2
(`server/mail.js`); when it is not configured the link is written to the server
log instead and the sign-in screen says so rather than promising an email that
will never arrive.

**Sign-up is open**, and it is safe because of BR-1 rather than in spite of it: a
new account opens onto its own work and returns 404 for everyone else's. A
hospital would provision accounts instead; open sign-up is right for a demo and
wrong for a clinic, and knowing the difference is the point.

Signing in from a browser the account has not used sends an approval link. The
**Trust this browser for 30 days** box decides both how long the session lasts
and whether the browser is remembered at all; signing out ends both.

---

## Theme

Light and dark, toggled in the header, remembered in `localStorage`, defaulting
to the operating system setting. A small script in `index.html` applies the theme
before first paint so there is no white flash.

Colours are split into four roles that never borrow from each other:

- **accent** (orange in light, cyan in dark) — actions only;
- **severity** `--g0`–`--g4` — the DR grade, and nothing else;
- **danger** — errors;
- **notice** — the standing disclaimer, deliberately neutral, so that a permanent
  banner never competes with a real warning.

---

## Layout

```
web/
  index.html              pre-paint theme script
  vercel.json             SPA fallback (Vercel)
  public/_redirects       SPA fallback (Netlify, Cloudflare Pages)
  .env.example            VITE_API_URL
  public/assets/          landing images (optimised: 9.6 MB -> 0.54 MB)
  src/
    App.jsx               routing, theme, header
    api.js                every fetch, one place
    styles.css            design tokens, both themes
    landing/              the public page — landing.css is scoped to .rx-landing
    pages/                Login · Cases · NewCase · CaseDetail
server/
  server.js               routes, auth, the eight business rules
  db.js                   schema, grade labels
  ai.js                   the call to the grading service
  seed.js                 two demo doctors
  seed-demo.js            demo cases from demo-images/, with fallback
  precompute-demo.js      grade the demo images once, for that fallback
  demo-images/            fundus images + precomputed/ answers (committed)
ai/
  main.py                 /infer and /health
  requirements.txt
SETUP.md                  step-by-step first-run guide (Windows + the DGX)
DEPLOY.md                 step-by-step deployment runbook
docs/OPERATIONS.md        what to do when something is down — read this first
KNOWN-ISSUES.md           open items, with what a fix would touch
tools/
  sample_aptos.py         pull a balanced sample out of the APTOS set
  status.sh               "is RetinaX up, and which build?" — any host
  build-server-tar.sh     pack the API for prts-0, stamped with its commit
LICENSE                   Apache License 2.0
NOTICE                    attributions, dataset terms, clinical disclaimer
```

---

## Checking that it is up

Both services keep running inside tmux, so closing the JupyterLab terminal does
not stop them. To see the state of everything from either machine, in a terminal
or in a notebook cell:

```bash
bash tools/status.sh          # from a terminal
!bash ~/tools/status.sh               # from a notebook cell on prts-0
```

It reports the tmux sessions, what is bound to :8000 and :3000, the model's
`/health`, the API's `/api/health`, the other machine across Tailscale, and the
public tunnel. It exits non-zero when something did not answer, so a notebook
cell shows a red mark. It changes nothing and needs no root.

**It also tells you which build the API is running**, which used to be
unanswerable — `tools/build-server-tar.sh` stamps the version, commit and build
time into the tar, and `/api/health` reports them back:

```
which build is the API running
     version  v1.0.0
     commit   3807b12 on main
     built    2026-09-13T02:31:44Z   (deployed by tar)
```

Run it from a git checkout and it compares that commit against your HEAD, so
"is prts-0 running what I just pushed?" stops being a guess.

The two fields worth reading every time:

| field | what a bad value means |
|---|---|
| `model_loaded: false` | the checkpoint did not load — existing cases still open, new uploads fail |
| `thresholds_source: default` | `best_thresholds.npy` was not found, so grades come from naive rounding and are wrong in one direction |

To start whatever is missing:

```bash
bash server/run-on-host.sh start     # on prts-0
bash ai/run-on-dgx.sh   start        # on the Spark
```

Which command belongs on which machine — and how a deploy actually works — is in
[DEPLOY.md](DEPLOY.md). Read its first section before running anything; most
mistakes on this project have been the right command on the wrong machine.

---

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).

Apache-2.0 rather than MIT for two reasons that matter for research code: it
grants patent rights explicitly, and it requires anyone distributing a modified
version to say that they changed it. Both protect you and the next reader.

[NOTICE](NOTICE) carries the third-party attributions, the terms of the public
datasets used in development, the papers behind the architecture and the
explanation methods, and — first, in full — the clinical disclaimer. **RetinaX.ai
is not a medical device and must not be used to diagnose anyone.** Every OSI
licence disclaims warranty; none of them says that sentence. For this project it
belongs in the repository, not only on the screen.
