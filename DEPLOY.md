# Deploying RetinaX.ai

The shape we settled on:

```
Vercel            web/     the doctor's screens          https://retinax.vercel.app
Render            server/  API, database, images         https://retinax-api.onrender.com
DGX Spark         ai/      the model and the .pth        https://<tunnel>.trycloudflare.com
```

The model stays on the DGX Spark, which already has the weights and the dataset. It
is reached over a tunnel, so nothing has to be copied and no GPU has to be
rented. Render's free instance has 512 MB of RAM — PyTorch alone does not fit in
it, which is why the model is not deployed alongside the API.

Do the three parts **in this order**. Each one needs the URL of the one before it.

---

## 0 · Push to GitHub first

```bash
cd retinax
git init
git add .
git commit -m "chore: repository setup, ignore rules and README"
git branch -M main
git remote add origin https://github.com/<user>/retinax.git
git push -u origin main
```

Before pushing, run `git status` and confirm you do **not** see `node_modules/`,
`server/data/`, `server/uploads/`, `.env`, or a `.pth`. A file committed once
stays in the history even after you delete it.

`COMMITS.md` has the 20-commit sequence if you want the history split across the
team rather than one big commit — the course marks this, so it is worth the hour.

---

## 1 · The grading service, on the DGX Spark

```bash
cd ai
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
pip install -r requirements.txt      # fastapi, pillow, numpy — NOT torch
./run-on-dgx.sh
```

`run-on-dgx.sh` starts uvicorn on `0.0.0.0:8000` and a Cloudflare tunnel in front
of it, both inside `tmux` so they survive your SSH session ending, and prints the
public URL. `./run-on-dgx.sh url` prints it again later; `stop` stops both.

**Do not `pip install torch` on that machine.** The Spark is arm64 with a Grace
Blackwell GPU. The default PyPI wheel is the wrong build and will install
alongside the working PyTorch already there — the failure looks like
`torch.cuda.is_available()` going false, and it costs an afternoon. That is why
`requirements.txt` deliberately omits it. Run the check above first; if it
already prints a version and `True`, install nothing else.

Check the service: `curl localhost:8000/health` should answer
`{"ok":true,"model_loaded":true}` once the real `.pth` is loaded. While it still
says `false` you are running the stand-in.

Quick-tunnel URLs **change on every restart**. If the machine reboots, run
`./run-on-dgx.sh url` and paste the new one into `AI_URL` on Render — twenty
seconds, and it redeploys automatically.

**If the tunnel is down, the demo still works.** The demo cases carry
precomputed grades and heatmaps committed in `server/demo-images/precomputed/`,
so the deployed app comes back up fully populated either way. What stops working
is grading a *new* upload. That failure is visible and honest — the case shows
as failed rather than silently inventing a grade.

---

## 2 · The API, on Render

New → Blueprint → point it at the repo. `render.yaml` fills in the rest.
By hand: New → Web Service, root directory `server`, build `npm ci`, start
`node server.js`.

Environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | let Render generate one |
| `WEB_ORIGIN` | your Vercel URL — **exactly**, `https://`, no trailing slash |
| `AI_URL` | the `trycloudflare.com` URL from step 1, no trailing slash |
| `SEED_DEMO` | `1` |

You do not have the Vercel URL yet. Put `https://retinax.vercel.app` in for now
and correct it in step 3 — Vercel's project URL is predictable from the project
name, so it is usually right first time.

### Two failure modes, both worth knowing before they happen

**The cookie.** The session cookie is `httpOnly`. Once the front end and the API
are on different domains, a browser only accepts it with `SameSite=None; Secure`.
`server.js` switches to that when `NODE_ENV=production`. Forget that variable and
login fails in production while working perfectly on localhost, with no error in
the console — the request just comes back 401 and the cookie is silently dropped.

**CORS.** `WEB_ORIGIN` must match the front-end URL character for character.
`https://retinax.vercel.app/` with the trailing slash does not match
`https://retinax.vercel.app` and every request is rejected.

Check the deploy: `curl https://retinax-api.onrender.com/api/cases` should return
`{"error":"Not signed in"}`. That is the API alive and refusing you correctly.

### The free instance sleeps

After 15 minutes idle, Render suspends the instance and the next request takes
30–50 seconds to wake it. Open the site once a few minutes before you demo.
The disk is also wiped on that restart — which is what `SEED_DEMO=1` is for.

---

## 3 · The front end, on Vercel

Import the repo. Vercel detects Vite on its own; only these matter:

| | |
|---|---|
| Root directory | `web` |
| Build command | `npm run build` |
| Output directory | `dist` |

One environment variable:

| Variable | Value |
|---|---|
| `VITE_API_URL` | your Render URL, e.g. `https://retinax-api.onrender.com`, no trailing slash |

**`VITE_API_URL` is read at build time, not at runtime.** Changing it in the
dashboard does nothing until you redeploy. This is the single most confusing
thing about Vite on Vercel.

`web/vercel.json` sends unknown paths to `index.html`. Without it, refreshing on
`/cases/abc` returns 404 — there is no such file, the router lives in the browser.

Now go back to Render and correct `WEB_ORIGIN` to the real Vercel URL if it
differs from what you guessed.

---

## 4 · Domain and SSL

Vercel and Render both issue and renew Let's Encrypt certificates automatically,
on their own subdomains and on custom domains. There is nothing to configure.
What to actually check:

- the site loads over `https://` with no browser warning;
- **no mixed content** — an `http://` value in `VITE_API_URL` on an `https://`
  page is blocked by the browser outright. This is the most common mistake here;
- open DevTools → Application → Cookies after signing in, and confirm the `rx`
  cookie is present with `Secure` and `SameSite=None`.

A custom domain, if you want one: add it in the Vercel dashboard, point a `CNAME`
at the value they give you, wait for DNS, and the certificate issues itself.

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
7. with the tunnel up, upload a new image and watch it get graded;
8. sign out, sign in as `ha@retinax.ai`, and confirm Quang's cases are not visible
   (BR-1).

Step 6 is the demo. Lead with it.

---

## What is left open

**The database.** SQLite in a file, and Render's free disk is wiped on restart.
Demo cases come back automatically; anything uploaded during a session does not.
For a three-day build against a competition deadline this is the right trade —
but if the database itself is being marked, moving to Supabase Postgres is about
half a day (`server/db.js` and `server/server.js` from `better-sqlite3` to `pg`,
and images to Supabase Storage). Say so plainly if a judge asks; a defended
trade-off reads better than a hidden one.
