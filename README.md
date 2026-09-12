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

### Data model — three tables

| Table | What it holds |
|---|---|
| `doctors` | account, bcrypt password hash |
| `cases` | patient code, birth year, sex, eye, the image, status, and the doctor's assessment |
| `predictions` | the model's grade and its two explanation maps for a case — **write-once** |

`predictions.Grade` is never updated. A doctor who disagrees writes
`cases.CorrectedGrade` and `cases.Reason`; the model's grade stays visible next
to it. Disagreements are the training signal for the next model version.

### The four business rules the code actually enforces

| | Rule | Where |
|---|---|---|
| BR-1 | A doctor can only reach their own cases. Another doctor's case returns **404, not 403** — 403 would confirm it exists. | `ownCase()` in `server/server.js` |
| BR-2 | A case can only be marked once it has been graded (`409` otherwise). | `/api/cases/:id/mark` |
| BR-3 | Disagreeing requires **both** a grade 0–4 **and** a written reason (`400` otherwise). | `/api/cases/:id/mark` |
| BR-4 | The doctor's correction never touches `predictions.Grade`. | the `UPDATE` only names `cases` columns |

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

**`DEPLOY.md` is the step-by-step runbook.** What follows is the reference.

The shape: front end on **Vercel**, API on **Render**, and the grading service on
the lab machine that already holds the weights, reached over a Cloudflare tunnel.
Render's free instance has 512 MB of RAM and PyTorch does not fit in it, which is
why the model is not deployed next to the API.

### 1 · Front end — Vercel *or* Netlify *or* Cloudflare Pages

Any of the three works; the repo carries config for all of them.

| | Setting |
|---|---|
| Root directory | `web` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Environment variable | `VITE_API_URL` = your deployed API URL (no trailing slash) |

`web/vercel.json` and `web/public/_redirects` both do the same job — send every
unknown path to `index.html`. Without one of them, a refresh on `/cases/abc`
returns 404, because there is no such file: the router lives in the browser.

`VITE_API_URL` is read **at build time**, not at runtime. Change it and you must
redeploy.

### 2 · API — Render *or* Railway

`render.yaml` in the repo root is a Render blueprint; import it and Render fills
in the settings. By hand, or on Railway:

| | Setting |
|---|---|
| Root directory | `server` |
| Build command | `npm ci` |
| Start command | `node server.js` |

Environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` — **this one matters, see below** |
| `JWT_SECRET` | a long random string |
| `WEB_ORIGIN` | the deployed front-end URL, exactly, no trailing slash |
| `AI_URL` | where the grading service runs |
| `SEED_DEMO` | `1` to re-create demo cases on every boot |

**The cross-domain cookie trap.** The session cookie is `httpOnly`. Once the
front end and the API are on different domains, a browser only accepts it with
`SameSite=None; Secure`. `server.js` switches to that when `NODE_ENV=production`.
Forget the variable and login silently fails in production while working
perfectly on localhost — this is the single most common way this deploy breaks.

### 2b · Grading service — the lab machine, behind a tunnel

`uvicorn main:app --host 0.0.0.0 --port 8000` on the machine that has the `.pth`,
with `cloudflared tunnel --url http://localhost:8000` in front of it. Set the URL
it prints as `AI_URL` on Render. Quick-tunnel URLs change on restart; updating
the variable is a twenty-second job.

If that machine is asleep, the deployed demo still comes up fully populated:
`server/demo-images/precomputed/` holds a committed grade and heatmap for each
demo image, and seeding falls back to them when the live service cannot be
reached. Only grading a *new* upload requires the machine to be awake, and that
failure is shown honestly rather than faked.

Run `npm run precompute` once, locally, with the service up, whenever you change
the demo images — then commit `demo-images/precomputed/`.

### 3 · Database

Currently **SQLite**, a single file at `server/data/retinax.db`. On Node 22+ it is
reached through `node:sqlite`, built into Node — no native addon, no compiler,
nothing to fail on a fresh machine. `better-sqlite3` remains an optional
dependency and is used only on Node 20, where `node:sqlite` does not exist.
This is a deliberate choice for a three-day build: no network hop, no connection
pool, no second dashboard to configure, and the whole database is one file you
can copy.

It has one real cost, and it is worth stating plainly: **free tiers on Render and
Railway have an ephemeral filesystem.** On restart — including the automatic
sleep/wake cycle — the database file and every uploaded image are gone. Three
ways to live with that:

- **Boot re-seeding (what is wired up now).** `SEED_DEMO=1` re-creates the demo
  cases from `server/demo-images/` at every boot. The demo is never empty in
  front of a judge. Anything uploaded during a session is still lost on restart.
- **A persistent disk.** Render supports one; it is a paid plan. The block is in
  `render.yaml`, commented out. This is the smallest change that makes uploads
  survive.
- **Supabase Postgres.** Managed, free tier, survives everything, and matches the
  "Setup Database" line in the course checklist directly. It means rewriting the
  queries in `server/db.js` and `server/server.js` from `better-sqlite3` to `pg`,
  and moving image storage to Supabase Storage. Roughly half a day.

The first option is what is deployed. The third is the one to pick if the
database itself is being marked.

### 4 · Domain and SSL

Vercel, Netlify, Cloudflare Pages and Render all issue and renew Let's Encrypt
certificates automatically on both their own subdomains and custom domains. There
is nothing to configure. What to actually check after deploying:

- the site loads over `https://` with no browser warning;
- **no mixed content** — an `http://` API URL on an `https://` page is blocked by
  the browser, and this is what `VITE_API_URL` gets wrong most often;
- `WEB_ORIGIN` on the API matches the front-end URL character for character,
  including `https://` and no trailing slash, or CORS rejects every request.

For a custom domain: add it in the host's dashboard, point a `CNAME` at the value
they give you, wait for DNS, and the certificate is issued on its own.

### 5 · Repository

`.gitignore` keeps `node_modules/`, the database, uploaded images and the `.pth`
out of the repo. `server/demo-images/` **is** committed on purpose — it is the
only thing the deployed instance can re-seed itself from, so it must contain
public-dataset images and never real patient photographs.

See `COMMITS.md` for the commit sequence.

---

## API

All routes require the session cookie except login and the password-reset pair.

| Method | Route | |
|---|---|---|
| `POST` | `/api/login` | `{email, password, keepSignedIn}` |
| `POST` | `/api/logout` | |
| `GET` | `/api/me` | |
| `POST` | `/api/password/forgot` | always returns `{ok:true}` — see below |
| `POST` | `/api/password/reset` | `{token, password}` |
| `GET` | `/api/cases` | the signed-in doctor's cases only |
| `POST` | `/api/cases` | multipart: image + patient fields; grades on upload |
| `GET` | `/api/cases/:id` | |
| `POST` | `/api/cases/:id/mark` | `{agreement, correctedGrade?, reason?}` |
| `GET` | `/api/cases/:id/image` | |
| `GET` | `/api/cases/:id/heatmap` | |

**Password reset.** The token is random, single-use and expires in 30 minutes.
Only its SHA-256 hash is stored, so a leaked database cannot be turned back into
working reset links. `/api/password/forgot` answers identically whether or not
the address has an account — a different answer would tell an attacker which
doctors are registered. The link is currently printed to the server log with a
`TODO`; wiring an email provider (Resend, SendGrid, SMTP) is a one-function
change in `server/server.js`.

There is deliberately **no public sign-up route**. Accounts are seeded. A screening
tool that lets anyone create an account is a tool that lets anyone see fundus
images.

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
  server.js               routes, auth, the four business rules
  db.js                   schema, grade labels
  ai.js                   the call to the grading service
  seed.js                 two demo doctors
  seed-demo.js            demo cases from demo-images/, with fallback
  precompute-demo.js      grade the demo images once, for that fallback
  demo-images/            fundus images + precomputed/ answers (committed)
ai/
  main.py                 /infer and /health
  requirements.txt
render.yaml               Render blueprint for the API
SETUP.md                  step-by-step first-run guide (Windows + the DGX)
KNOWN-ISSUES.md           open items, with what a fix would touch
DEPLOY.md                 step-by-step deployment runbook
COMMITS.md                suggested commit sequence, split across the team
tools/
  sample_aptos.py         pull a balanced sample out of the APTOS set
  status.sh               "is RetinaX up?" — run it on either host
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
!bash ~/RetinaX.ai/tools/status.sh    # from a notebook cell
```

It reports the tmux sessions, what is bound to :8000 and :3000, the model's
`/health`, the API's `/api/health`, the other machine across Tailscale, and the
public tunnel. It exits non-zero when something did not answer, so a notebook
cell shows a red mark. It changes nothing and needs no root.

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
