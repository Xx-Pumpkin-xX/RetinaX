# Deploying and running RetinaX.ai

Read the first section before touching anything. Almost every mistake on this
project has been doing the right command on the wrong machine.

---

## The three machines

| Name | What it is | What runs there | You reach it by |
|---|---|---|---|
| **`prts`** | your Windows PC | git, the source of truth. Nothing serves traffic here. | PowerShell, or Git Bash for the `.sh` scripts |
| **`prts-0`** | the always-on Linux host | the **API** on `:3000` — Express, the SQLite database, and every uploaded image | JupyterLab terminal · Tailscale `100.75.0.83` |
| **`spark-063e`** | the DGX Spark | the **grading model** on `:8000` — FastAPI, the `.pth`, the GPU | JupyterLab terminal · Tailscale `100.126.54.48` |

Plus one thing that is not a machine: **Cloudflare Pages** serves the front end
at `https://retinax.pages.dev` and builds it automatically from whatever you push
to GitHub.

Three rules that follow from the table, and save the most time:

1. **All git happens on `prts`.** Neither Linux box has a checkout or talks to
   GitHub. They receive code as a tar.
2. **`prts-0` holds the only copy of the data.** The database and the uploaded
   fundus images live there and nowhere else. Nothing in a deploy may overwrite
   them — see the exclusion list in step 2.
3. **The Spark is reached privately**, over Tailscale, from `prts-0`. The model
   service has no authentication of any kind, so it must never be exposed to the
   public internet.

### How a request actually travels

```
browser  ->  retinax.pages.dev          Cloudflare Pages: the React build
         ->  /api/*                     a Pages Function proxies it, same-origin
         ->  API_ORIGIN (ngrok)         the tunnel in front of prts-0
         ->  prts-0:3000                Express, SQLite, the images
         ->  spark-063e:8000            the model, over Tailscale, only on upload
```

The proxy hop exists for one reason. Without it the page is on `pages.dev` and
the API is on a tunnel hostname, so the session cookie is a **third-party**
cookie: Safari blocks those outright, Firefox by default, Chrome in incognito.
The symptom is nasty — login appears to succeed, because the doctor's name came
back in the response body, and then every request after it is 401 because the
cookie was never stored. Proxied, the browser only ever sees one origin, the
cookie is first-party, and CORS stops applying at all.

> **Why not Render, as the old version of this file said?** Render's free
> instance wipes its disk on every restart, so uploaded images and the database
> did not survive a deploy. `prts-0` is always on and keeps them. Do not put the
> API back on a host with ephemeral storage.

---

## 1 · The front end — on `prts`, deployed by Cloudflare

There is nothing to run by hand. Pushing to `main` triggers the build.

```powershell
cd D:\DR_project\RetinaX.ai
git push
```

First-time project setup, in the Cloudflare dashboard — Workers & Pages → Create
→ Pages → Connect to Git:

| Setting | Value |
|---|---|
| Framework preset | **Vite** |
| Build command | `npm run build` |
| Build output directory | `dist` |
| **Root directory** *(under Advanced)* | **`web`** |

The root directory is the one people miss. Leave it blank and Cloudflare builds
from the repository root, finds no `package.json`, and fails.

Environment variables, under Settings → Environment variables → **Production**:

| Variable | Value |
|---|---|
| `API_ORIGIN` | the tunnel in front of `prts-0`, e.g. `https://acuteness-finless-pluck.ngrok-free.dev` — **no trailing slash** |
| `VITE_API_URL` | **leave unset** |

`VITE_API_URL` must stay empty. `web/src/api.js` falls back to `""`, which makes
every call same-origin `/api/...`, which is what the Pages Function picks up. Set
it to the tunnel and you bypass the proxy and reintroduce the third-party-cookie
bug described above.

Two things that behave unintuitively here:

- **`VITE_API_URL` is read at build time, not run time.** Changing any `VITE_*`
  variable does nothing to a build that already happened — you must **Retry
  deployment**. This looks exactly like "the API is down".
- **`web/public/_redirects`** sends unknown paths to `index.html`. Without it,
  refreshing on `/cases/abc` returns 404 — there is no such file, the router
  lives in the browser.

Branch previews get their own `https://<hash>.retinax.pages.dev`. They work,
because the proxy makes the API same-origin, but demo from the production URL.

---

## 2 · The API — built on `prts`, unpacked on `prts-0`

### 2.1 Build the tar (on `prts`, Git Bash)

```bash
cd /d/DR_project/RetinaX.ai
git status            # commit first — the stamp records the commit
bash tools/build-server-tar.sh
```

It prints what it made:

```
retinax-server-v1.0.0.tar.gz
  version   v1.0.0
  commit    3807b12 on main
  built     2026-09-13T02:31:44Z
  demo imgs excluded (--with-demo-images to add)
  size      44K
```

The script writes `server/BUILD` into the tar with that version, commit, branch
and timestamp. **That stamp is the whole point** — it is how `prts-0` can tell
you which code it is running instead of you guessing from behaviour. Commit
before packing, or the version reads `-dirty` and the commit is meaningless.

Add `--with-demo-images` only on a first deploy to a fresh box; they rarely
change and they are the bulk of the size.

**What the tar never contains**, verified by listing the packed archive rather
than trusting the exclude list — the script deletes the tar and exits non-zero if
an env file appears in it anyway:

- `server/.env`, `server/host.env`, `ai/dgx.env` — secrets
- `server/data/` — **the database**
- `server/uploads/` — **the fundus images**
- `server/node_modules/`

So unpacking over a running install cannot destroy the data. That is deliberate,
and it is why the exclusion list is checked rather than assumed.

### 2.2 Upload it

Drag the `.tar.gz` into JupyterLab on `prts-0`, into your home directory.

### 2.3 Unpack and restart (on `prts-0`)

```bash
cd ~                                    # server/ and tools/ sit here, not in a repo folder
tar xzf ~/retinax-server-v1.0.0.tar.gz
bash server/run-on-host.sh stop
bash server/run-on-host.sh start
bash tools/status.sh
```

`prts-0` has no git checkout, so there is no `RetinaX.ai` directory there — the
tar unpacks `server/` and `tools/` straight into your home directory. `$VAR_DIR`
points at `~/retinax-data`, outside both, which is why unpacking cannot reach the
database.

There is no `restart` subcommand — stop then start. `run-on-host.sh` runs the API
inside `tmux`, so it survives you closing the JupyterLab tab. `logs` tails it,
`status` is the short version of `status.sh`.

No `npm install` is needed unless `package.json` changed; the tar carries the
lockfile so you can tell.

### 2.4 Confirm the right code is live

`tools/status.sh` now answers this directly:

```
which build is the API running
     version  v1.0.0
     commit   3807b12 on main
     built    2026-09-13T02:31:44Z   (deployed by tar)
```

Run it on `prts` in Git Bash and it goes further — it compares that commit
against your checkout:

```
  -- BEHIND — this checkout is 259b937, the server is running 3807b12
     rebuild and redeploy:  bash tools/build-server-tar.sh
```

`packedBy: source` instead of `tar` means somebody copied files by hand rather
than deploying a tar. Worth knowing before you debug anything.

### 2.5 Configuration on `prts-0`

`server/host.env` — never committed, see `server/host.env.example`:

| Variable | What it is |
|---|---|
| `VAR_DIR` | where the database and uploads live. **Point it outside the unpack directory** so a deploy can never reach it. |
| `AI_URL` | `http://spark-063e:8000` — the model, over Tailscale |
| `WEB_ORIGIN` | `https://retinax.pages.dev` |
| `JWT_SECRET` | a real random value. If it is still the placeholder, every session token is forgeable. |
| `NGROK_DOMAIN` | the reserved domain fronting this host |
| `RESEND_API_KEY`, `MAIL_FROM` | password-reset email; without them the app says plainly that it cannot send |

Changing `JWT_SECRET` signs everyone out. That is the correct response to a leak.

---

## 3 · The model — on `spark-063e`

**Usually there is nothing to do here.** The model only needs deploying when
something under `ai/` changed. Day to day you just check it is up.

```bash
cd ~
bash ai/run-on-dgx.sh status
```

To start it:

```bash
bash ai/run-on-dgx.sh start
```

`run-on-dgx.sh` starts uvicorn on `0.0.0.0:8000` inside `tmux`. With
`TUNNEL=0` and `SERVE_API=0` — the correct settings now that the API lives on
`prts-0` — it starts the model and nothing else, and `prts-0` reaches it across
Tailscale rather than over the public internet.

**Do not `pip install torch` on that machine.** The Spark is arm64 with a Grace
Blackwell GPU. The default PyPI wheel is the wrong build and installs alongside
the working PyTorch already there; the failure looks like
`torch.cuda.is_available()` going false, and it costs an afternoon. Check first,
and if it prints a version and `True`, install nothing:

```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

`ai/requirements.txt` deliberately omits torch for this reason.

### The two fields to read every single time

```bash
curl -s localhost:8000/health
```

| Field | A bad value means |
|---|---|
| `model_loaded: false` | the checkpoint did not load. Existing cases still open fine; **new uploads fail**, visibly, as FAILED cases. |
| `thresholds_source: default` | `best_thresholds.npy` was not found, so grades come from naive rounding instead of the Nelder-Mead thresholds `[0.565, 1.441, 2.375, 3.042]`. **Every grade is then wrong in the same direction, and nothing looks broken.** This is the dangerous one. |

**If the model is down, the demo still works.** The demo cases carry precomputed
grades and heatmaps in `server/demo-images/precomputed/`, so the site comes up
fully populated. Only grading a *new* upload stops, and it fails honestly — the
case is marked FAILED rather than inventing a grade.

---

## 4 · Checking everything, from either Linux box

```bash
bash tools/status.sh
```

Works on `prts-0` and on `spark-063e`, and on `prts` in Git Bash. It reports the
tmux sessions, what is bound to `:8000` and `:3000`, the model's `/health`, the
API's `/api/health` and **which build it is**, the other machine across Tailscale,
and the public tunnel. It exits non-zero when something did not answer, so from a
notebook cell you get a red mark:

```python
!bash ~/tools/status.sh
```

It changes nothing and needs no root. Override ports if you have to:

```bash
MODEL_PORT=8000 API_PORT=3000 PEER=spark-063e bash tools/status.sh
```

---

## 5 · The end-to-end check, before you call it done

In a private window, on a phone if you can:

1. the site loads over https with no warning;
2. sign in as `quang@retinax.ai` / `retinax123`;
3. the worklist shows the demo cases — this proves seeding survived the deploy;
4. open a case: image, grade, heatmap, and the Default / CAM / CCEM switch all work;
5. disagree with a grade and try to save with no reason — it must refuse (BR-3);
6. save with a reason, then reload — the model's grade is **still there** next to
   your correction (BR-4). This is the thing the whole project is about; show it;
7. with the model up, upload a new image and watch it get graded;
8. sign out, sign in as `ha@retinax.ai`, and confirm Quang's cases are not
   visible (BR-1) — the API returns **404, not 403**, because 403 would confirm
   the case exists;
9. sign out, then reload. You must stay signed out. (The sign-out bug was a
   `clearCookie` without `Secure`: a browser refuses to let a non-Secure
   `Set-Cookie` overwrite a Secure one, so the session silently survived.)

Step 6 is the demo. Lead with it.

---

## Rollback

Keep the previous tar. Rolling back is unpacking it and restarting:

```bash
cd ~
tar xzf ~/retinax-server-<previous>.tar.gz
bash server/run-on-host.sh stop && bash server/run-on-host.sh start
bash tools/status.sh          # confirm the version went back
```

The data is untouched by either direction, because the tar never contains it.

Schema changes are the exception: `server/db.js` migrates forward with
`ensureColumn` on boot and has no down-migration. Rolling back code across a
schema change leaves the extra column in place — harmless, but know that it
happened.

---

## What is still open

**The database is a single SQLite file on one host.** There is no replica and no
automated backup. For a competition build that is a defensible trade, but say it
plainly if a judge asks; a defended trade-off reads better than a hidden one. The
cheap improvement is a nightly copy of `$VAR_DIR` to somewhere else on `prts-0`.

**The tunnel hostname is a single point of failure.** If ngrok is down, the site
cannot reach the API even though the API is fine.
