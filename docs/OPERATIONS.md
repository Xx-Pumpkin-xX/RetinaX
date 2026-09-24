# Operations

## Encryption

Encrypted: everything under `VAR_DIR` on prts-0 — the database
`data/retinax.db`, the uploaded fundus photographs and heatmaps in `uploads/`,
and the snapshots in `snapshots/`.

Tool: gocryptfs v2.6.1, mounted through FUSE. The application does no
encryption of its own.

- File contents: AES-256-GCM, 4 KiB blocks, one nonce and one auth tag per block
- File names: EME with AES, per-directory IV
- Master key: 256-bit, wrapped with scrypt (N = 2^18)

The passphrase is not stored on the machine, so the vault is opened by hand
after every reboot. `server/run-on-host.sh` refuses to start unless
`$VAR_DIR/.vault-open` is present, which only happens while the vault is open.

Not encrypted: database columns (the schema holds no patient names, only
`PatientCode` and `BirthYear`).

## prts-0 — API

    gocryptfs ~/retinax-vault ~/retinax-data
    bash server/run-on-host.sh start
    bash server/run-on-host.sh status
    bash server/run-on-host.sh stop
    bash server/run-on-host.sh logs
    bash tools/status.sh
    curl -s http://localhost:3000/api/health
    fusermount3 -u ~/retinax-data

Ollama bridge (the app-wide assistant needs it; case chat does not):

    tmux new -d -s ollama-proxy 'python3 ~/ollama-proxy.py'

## Tunnel

The API is reachable from the internet through a cloudflared quick tunnel. It
is started by hand and is not managed by `run-on-host.sh`:

    tmux new -d -s cftunnel 'cloudflared tunnel --url http://localhost:3000'
    tmux capture-pane -pt cftunnel | grep trycloudflare

A quick tunnel gets a **new hostname every time it starts**. When it does, two
things must be updated or the site cannot reach the API:

    1. Cloudflare Pages -> Settings -> Environment variables -> API_ORIGIN
       (then Deployments -> Retry deployment, or the old value stays live)
    2. server/host.env -> PUBLIC_URL, so `run-on-host.sh status` checks the
       address a browser actually uses

Deploy a new build. prts-0 runs from an unpacked tar, not from git, so
`git push` alone changes nothing here:

    bash tools/build-server-tar.sh          # on the dev machine
    cd ~
    tar xzf ~/retinax-server-<version>.tar.gz
    bash server/run-on-host.sh stop
    bash server/run-on-host.sh start

Snapshots:

    cd ~ && set -a && . server/host.env && set +a && bash snapshot.sh list
    cd ~ && set -a && . server/host.env && set +a && bash snapshot.sh save <name>
    cd ~ && set -a && . server/host.env && set +a && bash snapshot.sh restore <name>

## DGX Spark — model

    bash ai/run-on-dgx.sh
    bash ai/run-on-dgx.sh status
    bash ai/run-on-dgx.sh stop
    bash ai/run-on-dgx.sh logs
    curl -s http://100.126.54.48:8000/health

`ai/main.py` in git must stay the version that runs on the Spark: it carries
the `/chat` endpoint and the six lesion models as well as the fundus gate. A
copy without those is a downgrade.

The first request after the machine has been idle can exceed the API's
45-second timeout while the models load, which surfaces as a case in `FAILED`
state. That is what the Re-grade button is for.

## Accounts

A new account is created unconfirmed: sign-up emails a link that expires in 24
hours, and `POST /api/login` answers 403 until it is opened. The sign-in screen
offers `POST /api/email/resend` when that happens.

Signing in from an unrecognised browser sends an approval link instead, valid
15 minutes; opening it trusts that browser for 30 days.

Signing out clears the cookie, records the session's token id in
`revoked_sessions` so a copy of it stops working everywhere, and ends the
browser's device trust — so the next sign-in from it needs a fresh approval.

`DEMO_EMAILS` in `host.env` lists the accounts exempt from both, so the demo
can be signed into from any machine in the room. Everything in that list has a
publicly known password by design - keep it to demo accounts.

## After a full restart

    1. Spark:   bash ai/run-on-dgx.sh
    2. prts-0:  gocryptfs ~/retinax-vault ~/retinax-data
    3. prts-0:  tmux new -d -s ollama-proxy 'python3 ~/ollama-proxy.py'
    4. prts-0:  tmux new -d -s cftunnel 'cloudflared tunnel --url http://localhost:3000'
    5. prts-0:  bash server/run-on-host.sh start
    6. update:  the tunnel's new hostname into Pages API_ORIGIN and host.env
                PUBLIC_URL, then retry the Pages deployment
    7. check:   bash tools/status.sh
