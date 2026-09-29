/**
 * Delete every case, prediction, review and uploaded file — all doctors.
 *
 * Accounts are KEPT. Dropping the doctors table would lock everyone out of
 * their own app, and seed-demo.js needs a doctor row to hang cases on. This
 * empties the worklist; it does not un-register anybody.
 *
 * A REVIEWED case is a clinical record and the API refuses to delete one. This
 * script goes around that on purpose, from outside the app, because "reset the
 * demo database" is a different act from "a doctor deleted a patient's case".
 * The guard in server.js stays exactly as it is.
 *
 *   node reset-cases.js              # dry run — prints, deletes nothing
 *   node reset-cases.js --apply      # backs up the DB file, then deletes
 *
 * Run it the way the API runs, so it opens the same database:
 *
 *   cd ~ && set -a && . server/host.env && set +a && node reset-cases.js
 *
 * Without host.env, VAR_DIR is unset and node happily creates a brand-new
 * empty database next to you — the script then reports nothing to delete and
 * everything looks fine while the real data sits untouched somewhere else.
 */
import { DatabaseSync } from "node:sqlite";
import { unlink, copyFile } from "node:fs/promises";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const VAR_DIR = process.env.VAR_DIR || "./data";
const DB_PATH = path.join(VAR_DIR, "data", "retinax.db");

console.log(`database: ${path.resolve(DB_PATH)}`);
console.log(`mode:     ${APPLY ? "APPLY — this deletes" : "dry run"}\n`);

const db = new DatabaseSync(DB_PATH);

const doctors = db.prepare(`
  SELECT d.DoctorID, d.Email, d.FullName,
         (SELECT COUNT(*) FROM cases c WHERE c.DoctorID = d.DoctorID) AS n
    FROM doctors d ORDER BY n DESC`).all();

for (const d of doctors) {
  console.log(`  ${String(d.n).padStart(4)} cases   ${d.Email}   ${d.FullName ?? ""}`);
}

const counts = {
  cases: db.prepare("SELECT COUNT(*) n FROM cases").get().n,
  predictions: db.prepare("SELECT COUNT(*) n FROM predictions").get().n,
  reviews: db.prepare("SELECT COUNT(*) n FROM reviews").get().n,
};
console.log(`\n  totals: ${counts.cases} cases, ${counts.predictions} predictions, ` +
            `${counts.reviews} reviews`);
console.log(`  doctors kept: ${doctors.length}`);

if (!APPLY) {
  console.log("\nDry run. Nothing was deleted. Re-run with --apply.");
  process.exit(0);
}

// The backup is the whole point of being allowed to do this at all: one file
// copy turns an irreversible command into a reversible one.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${DB_PATH}.bak-${stamp}`;
await copyFile(DB_PATH, backup);
console.log(`\nbacked up -> ${path.resolve(backup)}`);

// Paths first, while the rows still exist to point at them.
const files = db.prepare(`
  SELECT ImagePath AS p FROM cases WHERE ImagePath IS NOT NULL
  UNION ALL SELECT HeatmapCamPath  FROM predictions WHERE HeatmapCamPath  IS NOT NULL
  UNION ALL SELECT HeatmapCcemPath FROM predictions WHERE HeatmapCcemPath IS NOT NULL
`).all().map((r) => r.p);

// Children before parents, or the foreign keys refuse.
db.exec("DELETE FROM reviews");
db.exec("DELETE FROM predictions");
db.exec("DELETE FROM cases");
console.log(`deleted ${counts.reviews} reviews, ${counts.predictions} predictions, ` +
            `${counts.cases} cases`);

let gone = 0;
for (const p of files) {
  try { await unlink(p); gone++; } catch { /* already missing: fine */ }
}
console.log(`unlinked ${gone} of ${files.length} files`);

const left = db.prepare("SELECT COUNT(*) n FROM cases").get().n;
console.log(`\ncases remaining: ${left}`);
console.log(`restore with:  cp ${path.resolve(backup)} ${path.resolve(DB_PATH)}`);
