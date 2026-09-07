import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";

const doctors = [
  { name: "Dr. Tran Minh Quang", email: "quang@retinax.ai", password: "retinax123" },
  { name: "Dr. Le Thu Ha", email: "ha@retinax.ai", password: "retinax123" },
];

for (const d of doctors) {
  const exists = db.prepare("SELECT 1 FROM doctors WHERE Email = ?").get(d.email);
  if (exists) {
    console.log("already there:", d.email);
    continue;
  }
  db.prepare(
    "INSERT INTO doctors (DoctorID, FullName, Email, PasswordHash, CreatedAt) VALUES (?,?,?,?,?)"
  ).run(randomUUID(), d.name, d.email, bcrypt.hashSync(d.password, 10), new Date().toISOString());
  console.log("created:", d.email, "/", d.password);
}
