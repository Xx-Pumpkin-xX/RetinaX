const { DatabaseSync } = require("node:sqlite");
const { unlinkSync } = require("node:fs");
const path = require("node:path");

const VAR = process.env.VAR_DIR || (process.env.HOME + "/retinax-data");
const db = new DatabaseSync(path.join(VAR, "data", "retinax.db"));
const email = process.argv[2];
const apply = process.argv.includes("--apply");

if (!email) {
  console.log(db.prepare(
    "SELECT d.Email, d.DoctorID, COUNT(c.CaseID) AS cases FROM doctors d " +
    "LEFT JOIN cases c ON c.DoctorID = d.DoctorID GROUP BY d.DoctorID").all());
  process.exit(0);
}
const doc = db.prepare("SELECT DoctorID FROM doctors WHERE Email = ?").get(email);
if (!doc) { console.error("no such doctor:", email); process.exit(1); }

const rows = db.prepare(
  "SELECT c.CaseID, c.ImagePath, p.HeatmapCamPath, p.HeatmapCcemPath FROM cases c " +
  "LEFT JOIN predictions p ON p.CaseID = c.CaseID WHERE c.DoctorID = ?").all(doc.DoctorID);

console.log(rows.length + " case(s) for " + email);
if (!apply) { console.log("dry run - add --apply to actually delete"); process.exit(0); }

for (const r of rows) {
  db.prepare("DELETE FROM reviews     WHERE CaseID = ?").run(r.CaseID);
  db.prepare("DELETE FROM predictions WHERE CaseID = ?").run(r.CaseID);
  db.prepare("DELETE FROM cases       WHERE CaseID = ?").run(r.CaseID);
  for (const f of [r.ImagePath, r.HeatmapCamPath, r.HeatmapCcemPath]) {
    if (f) try { unlinkSync(f); } catch {}
  }
}
console.log("deleted " + rows.length + " case(s) and their files");
