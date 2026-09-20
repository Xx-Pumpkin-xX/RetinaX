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

Deploy a new build:

    bash tools/build-server-tar.sh          # on the dev machine
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

## After a full restart

    1. Spark:   bash ai/run-on-dgx.sh
    2. prts-0:  gocryptfs ~/retinax-vault ~/retinax-data
    3. prts-0:  bash server/run-on-host.sh start
    4. check:   bash tools/status.sh
