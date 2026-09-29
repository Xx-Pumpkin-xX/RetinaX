/**
 * Remove accounts that have never done anything.
 *
 * A month of testing leaves a `doctors` table full of debris: probe addresses,
 * injection attempts that were correctly stored as literal strings, `a@mail.com`,
 * three accounts called `aaaaaaaaaa`. None of it is dangerous and all of it is
 * embarrassing the moment someone else reads the database.
 *
 * `reset-cases.js` deliberately keeps every account, because dropping the table
 * locks the whole team out of their own application. This is the narrow
 * companion: it removes ONLY accounts with no cases and no reviews to their
 * name — an account that has graded something is a clinical record holder and
 * is never touched, whatever its address looks like.
 *
 *   node purge-doctors.js                  # dry run — prints, deletes nothing
 *   node purge-doctors.js --apply          # backs up the DB file, then deletes
 *   node purge-doctors.js --keep a@b.com,c@d.com
 *
 * Always kept, without being asked: anything in DEMO_EMAILS, because that is
 * the account the demo signs in as.
 *
 * Run it the way the API runs, so it opens the same database:
 *
 *   cd ~ && set -a && . server/host.env && set +a && node tools/purge-doctors.js
 *
 * Without host.env, VAR_DIR is unset, node creates a brand-new empty database
 * next to you, and the script reports nothing to delete while the real accounts
 * sit untouched somewhere else.
 */
import { DatabaseSync } from "node:sqlite";
import { copyFile } from "node:fs/promises";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const VAR_DIR = process.env.VAR_DIR || "./data";
const DB_PATH = path.join(VAR_DIR, "data", "retinax.db");

const keepArg = process.argv[process.argv.indexOf("--keep") + 1];
const KEEP = new Set(
  [
    ...(process.env.DEMO_EMAILS ?? "").split(","),
    ...(process.argv.includes("--keep") ? (keepArg ?? "").split(",") : []),
  ]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

console.log(`database: ${path.resolve(DB_PATH)}`);
console.log(`mode:     ${APPLY ? "APPLY — this deletes" : "dry run"}`);
console.log(`kept:     ${[...KEEP].join(", ") || "(nothing named)"}\n`);

const db = new DatabaseSync(DB_PATH);

// An account is idle when nothing points at it from the two tables that hold
// work. Everything else attached to a doctor - a trusted browser, a pending
// sign-in link - is a convenience that can be recreated, so it does not earn
// the account a reprieve; it just has to be removed with it.
const rows = db.prepare(`
  SELECT d.DoctorID, d.Email, d.FullName, d.CreatedAt,
         (SELECT COUNT(*) FROM cases c WHERE c.DoctorID = d.DoctorID) AS cases,
         (SELECT COUNT(*) FROM reviews r
            JOIN cases c2 ON c2.CaseID = r.CaseID
           WHERE c2.DoctorID = d.DoctorID) AS reviews
    FROM doctors d
   ORDER BY cases DESC, d.Email`).all();

const idle = [];
const active = [];
for (const r of rows) {
  const protectedRow = KEEP.has(String(r.Email).toLowerCase());
  if (r.cases > 0 || r.reviews > 0 || protectedRow) active.push({ ...r, protectedRow });
  else idle.push(r);
}

console.log(`keeping ${active.length}:`);
for (const r of active) {
  const why = r.protectedRow ? "named in --keep/DEMO_EMAILS" : `${r.cases} cases, ${r.reviews} reviews`;
  console.log(`  ${r.Email.padEnd(42)} ${why}`);
}

console.log(`\nwould remove ${idle.length}:`);
for (const r of idle) {
  console.log(`  ${r.Email.padEnd(42)} ${r.FullName ?? ""}`);
}

if (!idle.length) {
  console.log("\nNothing to remove.");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDry run. Nothing was deleted. Read the list above, then re-run with --apply.");
  process.exit(0);
}

// One file copy turns an irreversible command into a reversible one.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${DB_PATH}.bak-${stamp}`;
await copyFile(DB_PATH, backup);
console.log(`\nbacked up -> ${path.resolve(backup)}`);

const ids = idle.map((r) => r.DoctorID);
const holes = ids.map(() => "?").join(",");

// Children before parents, or the foreign keys refuse.
for (const table of ["trusted_devices", "login_verifications"]) {
  const n = db.prepare(`DELETE FROM ${table} WHERE DoctorID IN (${holes})`).run(...ids).changes;
  if (n) console.log(`  ${table}: ${n}`);
}
const gone = db.prepare(`DELETE FROM doctors WHERE DoctorID IN (${holes})`).run(...ids).changes;

console.log(`\nremoved ${gone} account(s). ${active.length} left.`);
