# Operations

Written to be used while something is broken. The recovery runbook is first,
on purpose — in an emergency nobody scrolls.

Three machines. Only two of the six processes restart themselves; the other
four die silently and stay dead until someone starts them.

| Machine | Process | Listens on | Started by |
|---|---|---|---|
| prts-1 (Windows) | nothing runs here | — | holds git, builds tars |
| Cloudflare Pages | the web app + the `/api/*` proxy | retinax.pages.dev | a push to `main` |
| prts-0 | gocryptfs vault | `~/retinax-data` | **by hand**, needs the passphrase |
| Spark | tailscaled (userspace), tmux `ts` | the tailnet itself | **by hand**, respawn loop |
| prts-0 | node API, tmux `retinax-api` | :3000 | `server/run-on-host.sh` |
| prts-0 | cloudflared, tmux `cftunnel` | a public hostname → :3000 | **by hand** |
| prts-0 | ollama proxy, tmux `ollamaproxy` | 127.0.0.1:11500 → Spark | **by hand** |
| Spark | uvicorn grading model, tmux `retinax-ai` | :8000 | `retinax-ai/run-on-dgx.sh` |
| Spark | ollama, tmux `ollama` | :11434 | **by hand** |

`tailscaled` is the one nobody remembers. It is not a property of the network:
it is a userspace binary in `~/tailscale_*_arm64/`, started by hand in tmux `ts`,
with no systemd and no root behind it. When it dies, **both** paths below die at
the same instant — and two independent services failing together is the
signature of the route being gone rather than the services. On 29 Sep 2026 it
was killed with no shutdown line in its log and stayed dead until someone looked.

Two paths through it, and they fail independently:

    grading    browser → Pages → tunnel → API:3000 → Tailscale → Spark:8000
    assistant  browser → Pages → tunnel → API:3000 → proxy:11500 → Spark:11434

---

## Recovery — the short way

Two commands, Spark first. Each script checks every step before starting the
next, skips whatever is already running, and stops with the exact line to type
when it hits something it must not do for you.

    # Spark, in the JupyterLab terminal
    bash ~/Projects/USTH/ProjectDR2026/retinax-ai/start-all-dgx.sh

    # prts-0
    cd ~ && bash tools/start-all.sh

Neither one opens the vault: that passphrase is deliberately not on the machine.
`start-all.sh` stops and prints the `gocryptfs` line when it finds it closed.

If `start-all.sh` starts a new tunnel it rewrites `PUBLIC_URL` in `host.env` and
then prints, loudly, the one thing no script can do — setting `API_ORIGIN` in
Cloudflare Pages and retrying the deployment. Miss that and the site loads while
every request inside it fails, which looks exactly like the API being down.

The long form below is what those two scripts do, step by step. Read it when a
script stops on a step, or when something is wrong in a way it does not cover.

## Recovery — the long way

Do these in order. Each step says what proves it worked. If a check fails,
fix that step before going on; skipping ahead is how an afternoon disappears.

### 1. Spark — the grading model

    cd ~/Projects/USTH/ProjectDR2026
    bash retinax-ai/run-on-dgx.sh
    bash retinax-ai/run-on-dgx.sh status

B7 takes 30–60 s to load. **Proof:** `status` prints `model … cuda`, and
`lesion  established: EX HE MA SE | provisional: IRMA NV`. Six lesion classes,
not five.

### 2. Spark — ollama, for the assistant

    curl -s http://127.0.0.1:11434/api/tags | grep -o '"name":"[^"]*"'

Empty means it is not running:

    tmux new -d -s ollama 'ollama serve'
    sleep 5
    ollama list

**Proof:** the model named in `CHAT_MODEL` (`host.env` on prts-0, default
`qwen3.5:4b`) appears in the list, spelled identically. `chatReachable()`
compares the whole string; one character off reads as "not installed".

### 2b. Spark — tailscaled, the route itself

    ls -S /tmp/tailscaled.sock && tmux ls | grep '^ts:'

No socket means the tailnet is gone and prts-0 can reach neither service:

    TS=$(ls -d ~/tailscale_*_arm64 | tail -1)
    tmux kill-session -t ts 2>/dev/null
    tmux new -d -s ts "while true; do '$TS/tailscaled' --tun=userspace-networking \
        --socket=/tmp/tailscaled.sock --state=$HOME/tailscaled.state >> $HOME/tailscaled.log 2>&1; \
      echo \"[respawn] tailscaled exited at \$(date -Is)\" >> $HOME/tailscaled.log; sleep 5; done"
    sleep 5
    $TS/tailscale --socket=/tmp/tailscaled.sock status | head -3

`tailscaled.state` persists, so no auth key is needed unless that file is lost.

**Proof:** from prts-0, `tailscale status | grep spark` shows the Spark without
the word `offline`.

### 3. prts-0 — open the vault. Nothing else until this is right.

    mountpoint ~/retinax-data

Not a mountpoint:

    ~/bin/gocryptfs ~/retinax-vault ~/retinax-data

**If gocryptfs answers `Invalid mountpoint: directory … not empty`, STOP.**
Either the vault is already mounted — check with `findmnt ~/retinax-data`, a
line containing `fuse.gocryptfs` means yes, carry on — or there is plaintext
sitting in the mountpoint from an earlier start on a closed vault. Do not
delete it and do not mount over it. Mount the vault somewhere else and compare
the two before deciding:

    mkdir -p ~/vault-check && ~/bin/gocryptfs ~/retinax-vault ~/vault-check
    ls ~/retinax-data/uploads | wc -l ; ls ~/vault-check/uploads | wc -l
    ls -la ~/retinax-data/data/retinax.db ~/vault-check/data/retinax.db

The one with the photographs is the real data. Then `fusermount -u
~/vault-check` (`fusermount3` on newer systems), move the loser aside under a
dated name, and mount the vault at `~/retinax-data`.

**Proof:** `mountpoint` says it is one, and `ls ~/retinax-data/uploads | wc -l`
is the number of photographs you expect — not zero.

`run-on-host.sh` now refuses to start when the vault is closed, so a mistake
here stops the deploy instead of quietly creating a second, empty database.

### 4. prts-0 — the ollama proxy

    tmux new -d -s ollamaproxy 'python3 ~/tools/ollama-proxy.py'
    sleep 2
    curl -s http://127.0.0.1:11500/api/tags | grep -o '"name":"[^"]*"'

**Proof:** the same model name as in step 2. Nothing, and `tmux ls` has no
`ollamaproxy`, means the script died on start — run it in the foreground to
see why.

### 5. prts-0 — the API

    cd ~ && bash server/run-on-host.sh

**Proof:** `api  db ok | model ok | assistant on | mail ok`. `assistant off`
means step 2 or step 4 is not done.

### 6. prts-0 — the tunnel

Not started by `run-on-host.sh`. Kill any old one first, or two cloudflareds
run with two hostnames and you will publish the wrong one:

    tmux kill-session -t cftunnel 2>/dev/null
    tmux new -d -s cftunnel 'cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:3000 2>&1 | tee ~/cftunnel.log'
    sleep 10
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' ~/cftunnel.log | tail -1

Every flag earns its place:

- `--no-autoupdate` — cloudflared updates itself daily and restarts, which
  changes the hostname with nobody touching anything. That is what happened on
  24 Sep 2026.
- `--protocol http2` — the default is QUIC over UDP 7844, which this network
  blocks. The tunnel appears to start and then serves nothing.
- `tee ~/cftunnel.log` — **not** `~/server/tunnel.log`: `run-on-host.sh`
  truncates that file on every start, so the hostname disappears the next time
  the API restarts.

### 7. Put the hostname in both places

    U=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' ~/cftunnel.log | tail -1)
    sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$U|" ~/server/host.env
    echo "$U"

Then Cloudflare Pages → Settings → Environment variables → `API_ORIGIN` = that
string, no trailing slash → **Deployments → Retry deployment**. Without the
retry the old value stays live.

Miss this step and the symptom is misleading: the site loads and every request
inside it fails, which looks exactly like the API being down.

### 8. Final check

    bash server/run-on-host.sh status
    tmux ls

Good looks like this:

    tmux    running
    build   v1.1.0-… | packed by tar | node v22.x | up 12s
    api     db ok | model ok | assistant on | mail ok
    model   tf_efficientnet_b7_ns | 600px | cbam on | tta on | cuda
    lesion  established: EX HE MA SE | provisional: IRMA NV
    grade   best_thresholds.npy | cuts 0.565 1.441 2.375 3.042
    public  https://….trycloudflare.com  ok

`tmux ls` must list all three: `retinax-api`, `ollamaproxy`, `cftunnel`.

Then open the site, sign in, and upload one photograph. That is the only test
that exercises all three tiers; `status` proves each machine is alive, not that
they can reach each other.

---

## Reading the status line

    build   which tar is unpacked here. `packed by source` means somebody
            copied files by hand — the version is then a guess.
    api     db = the database opened. model = the Spark answered.
            assistant = ollama reachable through the proxy. mail = Gmail
            credentials present.
    lesion  provisional classes are shown in the UI as hints and, for NV, as
            "not assessed" rather than "0". Never as a count to rely on.
    public  `ok` means the API answered through the tunnel. Anything else
            prints the first 120 bytes of what did answer — a Cloudflare 1016
            page means the hostname has no live tunnel behind it.

Raw JSON instead of the table: `bash server/run-on-host.sh status --raw`.

---

## Encryption

Encrypted: everything under `VAR_DIR` on prts-0 — the database
`data/retinax.db`, the uploaded fundus photographs and heatmaps in `uploads/`,
and snapshots, **provided `SNAPSHOT_DIR` puts them there** (see below).

Tool: gocryptfs, mounted through FUSE. The application does no encryption of
its own. The binary lives at `~/bin/gocryptfs` on prts-0 and is the only thing
that can open the vault, so the exact build is recorded here — rebuilding the
machine means fetching this line, not the newest release:

    gocryptfs v2.6.1 without_openssl; go-fuse v2.8.0; 2025-08-10 go1.24.6 linux/amd64

`without_openssl` means it uses Go's own crypto rather than the system OpenSSL.
The on-disk format is the same either way, so a vault written by this build
opens with an OpenSSL build of the same version and the reverse.

- File contents: AES-256-GCM, 4 KiB blocks, one nonce and one auth tag per block
- File names: EME with AES, per-directory IV
- Master key: 256-bit, wrapped with scrypt (N = 2^18)

The passphrase is not stored on the machine, so the vault is opened by hand
after every reboot. `server/run-on-host.sh` refuses to start unless
`$VAR_DIR/.vault-open` exists or `VAR_DIR` is a mount point.

Not encrypted: database columns (the schema holds no patient names, only
`PatientCode`, `BirthYear` and `PatientSex`).

---

## prts-0 — API

    bash server/run-on-host.sh              # start
    bash server/run-on-host.sh status       # the table above
    bash server/run-on-host.sh status --raw # the JSON behind it
    bash server/run-on-host.sh stop
    bash server/run-on-host.sh logs
    bash tools/status.sh
    curl -s http://localhost:3000/api/health
    fusermount -u ~/retinax-data            # fusermount3 on newer systems

---

## Flushing and restoring the data

Every tool here reads `VAR_DIR` from `host.env`. **Run without loading it and
node creates a fresh empty database next to you, reports nothing to delete, and
the real data sits untouched somewhere else while everything looks fine.** So
every session starts the same way, with the API stopped so SQLite is not open:

    mountpoint ~/retinax-data
    cd ~ && bash server/run-on-host.sh stop
    set -a && . server/host.env && set +a

Take a restore point first. `SNAPSHOT_DIR` is not decoration: the default is
`~/retinax-snapshots`, which is **outside the vault**, so the database and
every fundus photograph land on disk unencrypted.

    SNAPSHOT_DIR="$VAR_DIR/snapshots" bash tools/snapshot.sh save before-flush
    SNAPSHOT_DIR="$VAR_DIR/snapshots" bash tools/snapshot.sh list

Empty the worklist. **`reset-cases.js` deletes every case, prediction, review
and uploaded file, for all doctors** — it does not "un-review" anything. It
runs dry by default and prints what it would remove:

    node tools/reset-cases.js               # prints, deletes nothing
    node tools/reset-cases.js --apply       # backs up the db file, then deletes

Accounts survive: `doctors` and `trusted_devices` are untouched, so nobody has
to confirm an address or approve a browser again.

Put it back:

    SNAPSHOT_DIR="$VAR_DIR/snapshots" bash tools/snapshot.sh restore before-flush

`restore` moves the current state aside before overwriting, so restoring the
wrong snapshot is recoverable. `SNAPSHOT_DIR` is needed on `restore` and `list`
as well — leave it off and the script looks in the default directory and
reports no snapshots at all.

Rebuild demo data — **this one needs the API running**, because it uploads
through the real HTTP API, so every image is graded by the Spark and it takes
minutes, not seconds:

    bash server/run-on-host.sh
    node tools/seed-cases.mjs

---

## Operational scripts

These ship inside every server tar, so prts-0 always has the current copy and
none of them exists as a single file on one machine any more — which is what
they were until 29 Sep 2026:

    tools/snapshot.sh        save and restore the database and the images
    tools/ollama-proxy.py    rewrites the Host header so ollama accepts tailnet traffic
    tools/seed-cases.mjs     create demo cases through the real API (API must be up)
    tools/purge-demo.js      list doctors; with an email and --apply, delete that
                             doctor's cases and files
    tools/reset-cases.js     DELETE every case, prediction, review and image file
    tools/seed-quang.mjs     seed the demo account only (hard-codes a DoctorID)
    tools/status.sh          one-shot health summary
    tools/start-all.sh       bring prts-0 all the way up, checking each step
    tools/purge-doctors.js   remove accounts that have never filed a case
    ai/start-all-dgx.sh      the same for the Spark: tailnet, ollama, model
    tools/backup-prts0.sh    data snapshot + code tar + a performance baseline

---

## DGX Spark — model

    bash retinax-ai/run-on-dgx.sh
    bash retinax-ai/run-on-dgx.sh status
    bash retinax-ai/run-on-dgx.sh status --raw
    bash retinax-ai/run-on-dgx.sh stop
    bash retinax-ai/run-on-dgx.sh logs
    curl -s http://100.126.54.48:8000/health

The Spark has **no git checkout and no version control** — its directory is
ignored by the parent repository's `.gitignore`. It is deployed by unpacking
`retinax-ai-<version>.tar.gz`, and the only copy of any local edit is on that
machine. Extract with `tar xzf … && rm -rf retinax-ai && mv ai retinax-ai`, in
that order: `rm -rf` before the tar is known to be good has already destroyed
`dgx.env` once.

`ai/main.py` in git must stay the version that runs on the Spark: it carries
the `/chat` endpoint and the six lesion models as well as the fundus gate. A
copy without those is a downgrade.

The service warms itself at startup: one dummy forward at the real input size,
so the CUDA context and cuDNN's algorithm search are paid for before anyone
uploads anything. The log says `[startup] warm-up forward in Xs`. Without it the
first request after an idle machine regularly exceeded the API's 45-second
timeout and came back as a `FAILED` case, which reads to a clinician as a
rejected photograph. Re-grade still exists for the cases that predate this.

---

## Accounts

A new account is created unconfirmed: sign-up emails a link that expires in 24
hours, and `POST /api/login` answers 403 until it is opened. The sign-in screen
offers `POST /api/email/resend` when that happens.

Opening the confirmation link both confirms the address **and trusts that
browser for 30 days**, so signing up costs one email and one click. The trust
follows the browser that opened the link, not the one that signed up — open it
on the machine you will actually be using.

Signing in from a browser that is not trusted sends an approval link instead,
valid 15 minutes.

Signing out ends the session **and** this browser's trust: the token id goes
into `revoked_sessions` so a copy of the cookie stops working everywhere, and
the `trusted_devices` row is deleted, so the next sign-in from here waits for an
approval email again. That is deliberate. The second step exists to prove the
person holds the mailbox, and an explicit sign-out is the moment to ask for that
proof again; a shared machine left trusted for thirty days after the doctor
thought they had left is what it prevents.

Two clocks, and the doctor sets the second one:

| | Set by | Length | Ends when |
|---|---|---|---|
| Address confirmed | the link in the sign-up email | forever | never |
| Browser remembered | the **Trust this browser for 30 days** box | 30 days | sign-out, 30 days, or a password reset |

There used to be three, and two of them were invisible: the session ran 14 days
or 1, the browser stayed trusted for 30 whatever happened, and nothing on screen
said either number. So a browser left alone asked for the password on day 14 and
for an email on day 30, for reasons the doctor could not have predicted.

Now one tick decides both. Ticked: this browser is remembered and signed in for
thirty days. Unticked: the session lasts a day, and any trust this browser had is
dropped immediately — unticking is an instruction to forget the machine, which is
what someone on a shared computer means by it. Approving a sign-in link does not
override the choice: the box was already ticked or not when the mail was sent.

`DEMO_EMAILS` in `host.env` lists the accounts exempt from confirmation and
approval, so the demo can be signed into from any machine in the room.
Everything in that list has a publicly known password by design — keep it to
demo accounts, and remember that testing the sign-up flow with a demo address
proves nothing, because it skips both steps.

---

## The assistant, and what it is allowed to do

Two conversations, one model host:

    app-wide     browser -> API /api/chat            -> proxy:11500 -> ollama
    per case     browser -> API /api/cases/:id/chat  -> Spark :8000 -> ollama

The per-case one puts the case record in front of the model, and that record
contains a clinician's free-text note. The note is quoted between `<<<NOTE` and
`NOTE>>>` and labelled as data; those two markers are stripped from the note
itself, because a note that can close the quotation can write outside it. The
note is truncated at `CHAT_NOTE_LIMIT` (1500). Nothing else is filtered.

That is mitigation, not prevention — prompt injection has no complete defence.
The property that holds is structural, and it is the one to state if anybody
asks:

**The assistant has no write path.** It cannot change a grade (`predictions.Grade`
is never updated by any route, BR-4), cannot create, edit or delete a case, and
writes nothing to the database — neither chat route touches SQL. A successful
injection produces a wrong sentence on screen and nothing else.

Ollama itself has no authentication and no rate limiting of its own. It is
reachable only over the tailnet, through the proxy, from the API. It must never
be exposed through the public tunnel.

## Deploying a new build

prts-0 runs from an unpacked tar, not from git, so `git push` alone changes
nothing there. Pages is the opposite: a push is the deploy.

On prts-1, in **Git Bash** — `bash` in PowerShell resolves to WSL, which on
this machine is broken:

    bash tools/build-server-tar.sh

Or from PowerShell, finding the right bash without guessing the path:

    $bash = Join-Path (Split-Path (Split-Path (Get-Command git).Source)) 'bin\bash.exe'
    & $bash tools/build-server-tar.sh

Commit before building: the version comes from `git describe --dirty`, so a
dirty tree ships a tar named `-dirty`.

Upload the tar to prts-0 through JupyterLab, then:

    ls -la ~/retinax-server-*.tar.gz
    cd ~
    tar xzf ~/retinax-server-<the exact name>.tar.gz
    bash server/run-on-host.sh stop
    bash server/run-on-host.sh

**Type the name out.** With two tars in `~`, `tar xzf ~/retinax-server-*.tar.gz`
expands to two arguments and tar reads the second as a member name inside the
first — which on 29 Sep 2026 silently reinstalled a build from that morning.

The tar carries `server/` and `tools/` only. It never contains `host.env`, the
database, the photographs or `node_modules`, so unpacking it over a running
deployment cannot lose data.

The tunnel is a separate tmux session in front of port 3000, so it survives an
API restart and the hostname does not change — no need to touch Pages again.
