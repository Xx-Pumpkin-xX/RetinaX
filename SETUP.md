# Setting up RetinaX.ai

Written for Windows, because that is where the repo lives. Everything except
the paths is identical on macOS and Linux.

There are two machines in this project and they need different things:

| | What runs there | What it needs |
|---|---|---|
| **Your PC** | the front end and the API | Node 20.12 or newer |
| **The DGX Spark** | the grading model | Python and the PyTorch already installed there |

Part 1 gets the app running on your PC alone, with a stand-in model, in about
ten minutes. Part 2 replaces the stand-in with the real weights on the Spark.
Do Part 1 first — if something is broken it is much easier to find with one
machine than two.

---

# Part 1 — running it on your PC

## 1.1 · Install Node

Download the **LTS** installer from <https://nodejs.org> and run it. Then open a
**new** PowerShell window (the old one will not know about Node yet) and check:

```powershell
node -v
```

**Take the LTS build, not "Current".** Anything from `v22` works and needs no
compiler. `v20.12`–`v20.x` also works but has to build a small native module,
which needs Visual Studio — see Troubleshooting if you are stuck on Node 20.

If PowerShell says *"running scripts is disabled on this system"* when you use
`npm`, that is Windows' execution policy, not a broken install. Fix it once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 1.2 · Install Python

From <https://www.python.org/downloads/>, and **tick "Add python.exe to PATH"** on
the first screen of the installer. Missing that tick is the single most common
Python-on-Windows problem. Check in a new window:

```powershell
python --version
```

## 1.3 · Install the dependencies

Three folders, three installs. Open PowerShell in the project folder:

```powershell
cd D:\DR_project\RetinaX.ai

cd server
npm install
cd ..\web
npm install
cd ..\ai
pip install -r requirements.txt
cd ..
```

On Node 22 or newer the database driver is `node:sqlite`, which is built into
Node — nothing is compiled and nothing can fail. You may see npm skip an optional
package called `better-sqlite3`; that is expected and harmless, it is only the
fallback for Node 20.

## 1.4 · Create the server's .env

```powershell
cd server
copy .env.example .env
```

Open `server\.env` and set `JWT_SECRET` to any long random string. The rest of
the defaults are already right for local work.

This file is **not** in the repository on purpose — it holds the secret that
signs session cookies, and secrets do not belong in git. That is why you have to
create it yourself, and why a teammate cloning the repo has to as well.

## 1.5 · Create the demo doctors

```powershell
cd server
npm run seed
```

You should see two accounts created. Skip this and every login will say *"Wrong
email or password"*, because there are no accounts to log into.

## 1.6 · Start the three processes

Three PowerShell windows, one each, all left running.

**Window 1 — the grading service**

```powershell
cd D:\DR_project\RetinaX.ai\ai
uvicorn main:app --port 8000
```

Wait for `Application startup complete`. This is running the **stand-in** model
for now: it produces a plausible grade and a real heatmap so the rest of the app
works end to end. Part 2 replaces it.

**Window 2 — the API**

```powershell
cd D:\DR_project\RetinaX.ai\server
npm run dev
```

Wait for `RetinaX API on http://localhost:3000`.

**Window 3 — the front end**

```powershell
cd D:\DR_project\RetinaX.ai\web
npm run dev
```

Open <http://localhost:5173>.

You should get the landing page. Click **Sign in** and use
`quang@retinax.ai` / `retinax123`.

## 1.7 · Fill it with demo cases

An empty worklist is a bad first impression. In a fourth window, with the other
three still running:

```powershell
cd D:\DR_project\RetinaX.ai\server
npm run seed:demo
```

That grades everything in `server\demo-images\` and creates cases from them.
Refresh the browser and the worklist has content.

Right now those are four **drawn placeholders**, not real retinas. Replace them
with 8–12 images from APTOS 2019 or EyePACS, then re-run the command above.

## 1.8 · Check it actually works

Walk this path before you believe it:

1. the landing page loads at `/`, and **Sign in** goes to `/login`;
2. you can sign in;
3. the worklist shows cases;
4. open one — image, grade, heatmap, and the Default / CAM / CCEM switch;
5. click **Disagree** and try to save with an empty reason — it must refuse;
6. save with a reason, reload, and confirm the AI's grade is **still shown** next
   to your correction;
7. **New case**, upload any JPEG, and watch it come back graded.

Step 6 is the thing the whole project is about. If it works, the app works.

---

# Part 2 — the grading model on the DGX Spark

Now swap the stand-in for the real weights.

## 2.1 · Check PyTorch before you touch anything

SSH into the Spark and run:

```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

If that prints a version and `True`, **do not install PyTorch.** The Spark is
arm64 with a Grace Blackwell GPU, and `pip install torch` from the default index
will fetch a build for the wrong architecture and install it alongside the
working one. The symptom is `torch.cuda.is_available()` quietly turning `False`,
and it costs an afternoon to unpick. This is why `ai/requirements.txt`
deliberately does not list torch.

## 2.2 · Copy the ai/ folder over and install the rest

```bash
scp -r ai/ you@spark:~/retinax-ai/
ssh you@spark
cd ~/retinax-ai
pip install -r requirements.txt      # fastapi, uvicorn, pillow, numpy only
```

## 2.3 · Put the weights in and wire them up

Copy `model.pth` into that folder, then edit `main.py`. Two blocks are marked
with `TODO`:

```python
def load_model():
    # torch.load your .pth, move it to the device, .eval(), return it
def predict(img):
    # your transform, forward pass, and CAM / CCEM
```

Also replace the placeholder thresholds with your Nelder-Mead cut points:

```python
THRESHOLDS = [0.57, 1.48, 2.51, 3.42]
```

Load the model **once at import**, not inside `predict()`. Reloading the weights
on every request will make the demo look broken.

The contract to keep: `/infer` returns `{"grade": 0-4, "heatmap_png_base64": ...}`
and **nothing else**. The regression score and the thresholds stay inside this
service — that is the reason it is a separate process.

## 2.4 · Start it, with a public URL

```bash
./run-on-dgx.sh
```

That starts uvicorn on `0.0.0.0:8000` and a Cloudflare tunnel in front of it,
both inside `tmux` so they survive your SSH session closing, and prints a public
`https://….trycloudflare.com` URL.

```bash
./run-on-dgx.sh url     # print the URL again
./run-on-dgx.sh stop    # stop both
tmux attach -t retinax-ai    # watch the logs (Ctrl-B then D to detach)
```

Check it from your PC's browser: `https://….trycloudflare.com/health` should say
`{"ok":true,"model_loaded":true}`. **`model_loaded:true` is how you know the real
weights are live** — while it says `false`, you are still on the stand-in.

## 2.5 · Point your PC at it

In `server\.env`, replace the AI URL with the tunnel URL:

```
AI_URL=https://your-tunnel-url.trycloudflare.com
```

Restart the API window (Ctrl-C, `npm run dev`). Upload a case — it is now being
graded by the real model on the Spark.

Then regenerate the demo answers so they come from the real model too:

```powershell
npm run precompute
npm run seed:demo
```

Commit `server\demo-images\precomputed\` afterwards. Those committed answers are
what keep the deployed demo populated when the Spark is asleep.

**Quick-tunnel URLs change every restart.** After a reboot, run
`./run-on-dgx.sh url` and update `AI_URL` — locally in `.env`, and on Render once
you have deployed.

---

# Troubleshooting

**`npm install` fails on better-sqlite3 with `gyp ERR! find VS ... could not find
Visual Studio 2017 or newer`.**

Read the third line of that error — it names your Node version. `better-sqlite3`
is a native C++ addon that ships prebuilt binaries only for Node versions it has
already seen. On a Node newer than the package (`No prebuilt binaries found
(target=26.7.0 …)`) it falls back to compiling from source, which needs a C++
compiler you almost certainly do not have.

You should not hit this any more: on Node 22+ the app uses `node:sqlite`, built
into Node itself, and never loads better-sqlite3 at all. It is an *optional*
dependency, so even when npm cannot build it the install still succeeds — the
red text is noise, and `npm run seed` will work regardless. Check with:

```powershell
npm run seed
```

If that creates the two doctors, you are fine. Only if you are on Node 20 and
genuinely need the native module: install "Desktop development with C++" from
the Visual Studio Build Tools, or just upgrade to Node 22 LTS and forget it.

**`.env not found. Continuing without it.`**
Not an error. The defaults in the code are the local-development values. You
still want a real `JWT_SECRET` before deploying.

**Every login says "Wrong email or password".**
You skipped `npm run seed`, or you are pointed at a fresh database. Re-run it.

**`EADDRINUSE: address already in use :::3000`.**
An old server is still running. Find and stop it:
```powershell
netstat -ano | findstr :3000
taskkill /PID <the number> /F
```

**Cases appear with status "Failed".**
The API could not reach the grading service. Check window 1 is still running, or
that `AI_URL` matches the current tunnel URL. Nothing is lost — delete the case
and upload again once the service is back.

**The page loads but every request 401s.**
The API is not running, or not on port 3000. In development the Vite dev server
proxies `/api` to `localhost:3000`; if window 2 is down, everything fails.

**`ExperimentalWarning: SQLite is an experimental feature`.**
Expected on Node 22.x. `node:sqlite` is built into Node and stable in practice;
the warning is Node's, not the app's, and nothing is wrong.

**`uvicorn` is not recognised.**
Python's scripts folder is not on PATH. Use `python -m uvicorn main:app --port 8000`.

**Changes to the front end do not show up.**
Vite hot-reloads on save. If it stops, Ctrl-C and `npm run dev` again. A hard
refresh is Ctrl-Shift-R.

---

# What each folder is

```
web/       the browser app — landing page, sign-in, worklist, case detail
server/    the API — accounts, cases, the four business rules, the database
ai/        the grading service — the .pth, CAM and CCEM
```

`README.md` explains the design. `DEPLOY.md` is for putting it on the internet.
`TRACEABILITY.md` maps the UML diagrams to the code. `COMMITS.md` is the commit
sequence for the team.
