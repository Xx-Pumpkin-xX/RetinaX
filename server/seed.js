/**
 * The two demo doctor accounts.
 *
 * Exported as a function because the deployed API has to call it at boot: a
 * free host wipes its disk on restart, and `seedDemo()` needs a doctor to own
 * the cases it creates. Run directly (`npm run seed`) it does the same thing
 * and prints what it did.
 */
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";

const doctors = [
  { name: "Dr. Tran Minh Quang", email: "quang@retinax.ai", password: "retinax123" },
  { name: "Dr. Le Thu Ha", email: "ha@retinax.ai", password: "retinax123" },
];

export function seedDoctors({ quiet = false } = {}) {
  const say = (...a) => { if (!quiet) console.log(...a); };
  let created = 0;
  const ids = [];

  for (const d of doctors) {
    const row = db.prepare("SELECT DoctorID FROM doctors WHERE Email = ?").get(d.email);
    if (row) {
      say("already there:", d.email);
      ids.push(row.DoctorID);
      continue;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO doctors (DoctorID, FullName, Email, PasswordHash, CreatedAt) VALUES (?,?,?,?,?)"
    ).run(id, d.name, d.email, bcrypt.hashSync(d.password, 10), new Date().toISOString());
    say("created:", d.email, "/", d.password);
    ids.push(id);
    created++;
  }
  // The caller seeds cases per doctor, so it needs the ids back.
  return { created, total: doctors.length, ids };
}

// Run directly rather than imported.
if (import.meta.url === `file://${process.argv[1]}`) seedDoctors();
