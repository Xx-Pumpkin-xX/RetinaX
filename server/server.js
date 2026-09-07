import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { db, GRADE_LABELS } from "./db.js";
import { gradeImage } from "./ai.js";
import { seedDemo } from "./seed-demo.js";

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:5173";

const app = express();
app.use(express.json());
app.use(cookieParser());

// Only needed when the front end is served from a different origin (production).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", WEB_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPEG or PNG images are accepted"), ok);
  },
});

/* ---------------------------------------------------------------- auth --- */

function auth(req, res, next) {
  const token = req.cookies.rx;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    req.doctorId = jwt.verify(token, SECRET).sub;
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
}

app.post("/api/login", (req, res) => {
  const { email, password, keepSignedIn } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  const doc = db.prepare("SELECT * FROM doctors WHERE Email = ?").get(String(email).toLowerCase().trim());
  if (!doc || !bcrypt.compareSync(password, doc.PasswordHash)) {
    return res.status(401).json({ error: "Wrong email or password" });
  }

  // "Keep me signed in" is only a longer cookie life. Never permanent:
  // this account can read patient images.
  const days = keepSignedIn ? 14 : 1;
  const token = jwt.sign({ sub: doc.DoctorID }, SECRET, { expiresIn: `${days}d` });
  // In dev the front end is proxied, so the cookie is same-site.
  // In production the API is usually on another domain, and a cross-site
  // cookie is only accepted with SameSite=None *and* Secure. Getting this
  // wrong is the classic "login works locally, fails once deployed".
  const cross = process.env.NODE_ENV === "production";
  res.cookie("rx", token, {
    httpOnly: true,
    sameSite: cross ? "none" : "lax",
    secure: cross,
    maxAge: days * 24 * 60 * 60 * 1000,
  });
  res.json({ id: doc.DoctorID, fullName: doc.FullName });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("rx");
  res.sendStatus(204);
});

/* ----------------------------------------------------- password reset --- */

// The token is random, single-use and expires. Only its SHA-256 hash is stored,
// so a leaked database cannot be turned back into working reset links.
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const RESET_MINUTES = 30;

app.post("/api/password/forgot", (req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  const doc = email ? db.prepare("SELECT DoctorID FROM doctors WHERE Email = ?").get(email) : null;

  if (doc) {
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + RESET_MINUTES * 60 * 1000).toISOString();
    // Issuing a new link invalidates any previous one, because there is only
    // ever one hash on the row.
    db.prepare("UPDATE doctors SET ResetTokenHash = ?, ResetTokenExpiry = ? WHERE DoctorID = ?")
      .run(sha256(token), expires, doc.DoctorID);

    // TODO before real users: send this by email (Resend / SendGrid / SMTP)
    // instead of printing it. Printing is honest for a demo; it is not a
    // password reset flow you can put in front of patients' doctors.
    console.log(`[reset] ${email} -> ${WEB_ORIGIN}/reset?token=${token} (valid ${RESET_MINUTES} min)`);
  }

  // Always the same answer, whether or not the address exists: a different
  // reply here tells an attacker which doctors have accounts.
  res.json({ ok: true });
});

app.post("/api/password/reset", (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: "Token and a new password are required" });
  if (String(password).length < 8) return res.status(400).json({ error: "Use at least 8 characters" });

  const doc = db.prepare("SELECT * FROM doctors WHERE ResetTokenHash = ?").get(sha256(String(token)));
  if (!doc || !doc.ResetTokenExpiry || new Date(doc.ResetTokenExpiry) < new Date()) {
    return res.status(400).json({ error: "This reset link has expired. Request a new one." });
  }

  // Clearing the hash in the same statement is what makes the link single-use.
  db.prepare(
    `UPDATE doctors SET PasswordHash = ?, ResetTokenHash = NULL, ResetTokenExpiry = NULL
     WHERE DoctorID = ?`
  ).run(bcrypt.hashSync(String(password), 10), doc.DoctorID);

  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  const doc = db.prepare("SELECT DoctorID, FullName, Email FROM doctors WHERE DoctorID = ?").get(req.doctorId);
  res.json({ id: doc.DoctorID, fullName: doc.FullName, email: doc.Email });
});

/* --------------------------------------------------------------- cases --- */

const caseRow = (row) => ({
  id: row.CaseID,
  patientCode: row.PatientCode,
  birthYear: row.BirthYear,
  patientSex: row.PatientSex,
  eye: row.EyePosition,
  status: row.Status,
  agreement: row.Agreement,
  correctedGrade: row.CorrectedGrade,
  reason: row.Reason,
  createdAt: row.CreatedAt,
  reviewedAt: row.ReviewedAt,
  grade: row.Grade ?? null,
  gradeLabel: row.Grade == null ? null : GRADE_LABELS[row.Grade],
  hasHeatmap: !!row.HeatmapPath,
});

app.get("/api/cases", auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, p.Grade, p.HeatmapPath FROM cases c
       LEFT JOIN predictions p ON p.CaseID = c.CaseID
       WHERE c.DoctorID = ? ORDER BY c.CreatedAt DESC`
    )
    .all(req.doctorId);
  res.json(rows.map(caseRow));
});

// BR-1: a doctor only ever sees their own cases. 404, not 403 —
// 403 would confirm that someone else's case exists.
function ownCase(id, doctorId) {
  return db
    .prepare(
      `SELECT c.*, p.Grade, p.HeatmapPath FROM cases c
       LEFT JOIN predictions p ON p.CaseID = c.CaseID
       WHERE c.CaseID = ? AND c.DoctorID = ?`
    )
    .get(id, doctorId);
}

app.get("/api/cases/:id", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });
  res.json(caseRow(row));
});

app.post("/api/cases", auth, upload.single("image"), async (req, res) => {
  const { patientCode, birthYear, patientSex, eyePosition } = req.body || {};
  if (!req.file) return res.status(400).json({ error: "An image is required" });
  if (!patientCode || !eyePosition) {
    return res.status(400).json({ error: "Patient code and eye are required" });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cases (CaseID, DoctorID, PatientCode, BirthYear, PatientSex,
                        EyePosition, ImagePath, Status, CreatedAt)
     VALUES (?,?,?,?,?,?,?,'PROCESSING',?)`
  ).run(id, req.doctorId, patientCode.trim(), Number(birthYear) || null,
        patientSex || null, eyePosition, req.file.path, now);

  try {
    const { grade, heatmapPath } = await gradeImage(path.resolve(req.file.path));
    db.prepare(
      `INSERT INTO predictions (PredictionID, CaseID, Grade, HeatmapPath, CreatedAt)
       VALUES (?,?,?,?,?)`
    ).run(randomUUID(), id, grade, heatmapPath, new Date().toISOString());
    db.prepare("UPDATE cases SET Status = 'GRADED' WHERE CaseID = ?").run(id);
  } catch (err) {
    console.error("grading failed:", err.message);
    db.prepare("UPDATE cases SET Status = 'FAILED' WHERE CaseID = ?").run(id);
    return res.status(502).json({ id, error: "The grading service did not answer" });
  }

  res.status(201).json(caseRow(ownCase(id, req.doctorId)));
});

app.post("/api/cases/:id/mark", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });
  if (row.Status !== "GRADED") {
    return res.status(409).json({ error: "This case is not ready to review" }); // BR-2
  }

  const { agreement, correctedGrade, reason } = req.body || {};
  if (!["AGREE", "DISAGREE"].includes(agreement)) {
    return res.status(400).json({ error: "agreement must be AGREE or DISAGREE" });
  }

  // BR-3: disagreeing without a corrected grade and a reason produces
  // nothing you can retrain from, so the server refuses it.
  let grade = null;
  let why = null;
  if (agreement === "DISAGREE") {
    grade = Number(correctedGrade);
    why = (reason || "").trim();
    if (!Number.isInteger(grade) || grade < 0 || grade > 4) {
      return res.status(400).json({ error: "A corrected grade of 0-4 is required" });
    }
    if (!why) return res.status(400).json({ error: "A reason is required when you disagree" });
  }

  // BR-4: predictions.Grade is never touched.
  db.prepare(
    `UPDATE cases SET Agreement = ?, CorrectedGrade = ?, Reason = ?,
            Status = 'REVIEWED', ReviewedAt = ? WHERE CaseID = ?`
  ).run(agreement, grade, why, new Date().toISOString(), req.params.id);

  res.json(caseRow(ownCase(req.params.id, req.doctorId)));
});

/* --------------------------------------------------------------- files --- */

app.get("/api/cases/:id/image", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.sendStatus(404);
  res.sendFile(path.resolve(row.ImagePath));
});

app.get("/api/cases/:id/heatmap", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row || !row.HeatmapPath) return res.sendStatus(404);
  res.sendFile(path.resolve(row.HeatmapPath));
});

/* ---------------------------------------------------------------- misc --- */

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Something went wrong" });
});

app.listen(PORT, async () => {
  console.log(`RetinaX API on http://localhost:${PORT}`);
  // Free hosts wipe the disk on restart. This puts the demo data back.
  if (process.env.SEED_DEMO === "1") {
    try { await seedDemo(); } catch (e) { console.warn("[demo]", e.message); }
  }
});
