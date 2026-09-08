import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "node:path";
import { openSync, readSync, closeSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { db, GRADE_LABELS } from "./db.js";
import { gradeImage } from "./ai.js";
import { seedDemo } from "./seed-demo.js";
import { seedDoctors } from "./seed.js";
import { UPLOAD_DIR } from "./paths.js";

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
  // ngrok-skip-browser-warning is a custom header, so every request carrying
  // it is preflighted. Omit it here and the browser rejects the response
  // before your code ever sees it.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, ngrok-skip-browser-warning");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const upload = multer({
  // diskStorage rather than `dest`, only to keep the file extension.
  // multer's dest mode writes a random name with no extension, so res.sendFile
  // cannot infer a content type and answers application/octet-stream. A browser
  // sniffs that and shows the picture anyway; a fetch that checks the type -
  // which is how the images are loaded now - correctly refuses it.
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${/^\.(jpe?g|png)$/.test(ext) ? ext : ".jpg"}`);
    },
  }),
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

/**
 * One place that knows how the session cookie is built, because login and
 * sign-up must agree. "Keep me signed in" only lengthens its life — never
 * permanent, since this account can read fundus images.
 *
 * In dev the front end is proxied, so the cookie is same-site. In production
 * the API is on another domain, and a cross-site cookie is only accepted with
 * SameSite=None *and* Secure. Getting this wrong is the classic "login works
 * locally, fails once deployed".
 */
function issueSession(res, doctorId, keepSignedIn) {
  const days = keepSignedIn ? 14 : 1;
  const token = jwt.sign({ sub: doctorId }, SECRET, { expiresIn: `${days}d` });
  const cross = process.env.NODE_ENV === "production";
  res.cookie("rx", token, {
    httpOnly: true,
    sameSite: cross ? "none" : "lax",
    secure: cross,
    maxAge: days * 24 * 60 * 60 * 1000,
  });
}

app.post("/api/login", (req, res) => {
  const { email, password, keepSignedIn } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  const doc = db.prepare("SELECT * FROM doctors WHERE Email = ?").get(String(email).toLowerCase().trim());
  if (!doc || !bcrypt.compareSync(password, doc.PasswordHash)) {
    return res.status(401).json({ error: "Wrong email or password" });
  }

  issueSession(res, doc.DoctorID, keepSignedIn);
  res.json({ id: doc.DoctorID, fullName: doc.FullName });
});

/* --------------------------------------------------------------- sign up --- */

// Open sign-up, deliberately: this is a competition demo and anyone should be
// able to try it. BR-1 is what makes that safe — a doctor only ever sees cases
// where DoctorID is their own, so a new account starts with a view of nothing
// but its own work.
//
// This is a DEMO decision and the report should say so. A screening tool a
// hospital actually ran would provision accounts, not let the internet join.
app.post("/api/signup", async (req, res) => {
  const fullName = String(req.body?.fullName || "").trim();
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");

  if (!fullName || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are all required" });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "That does not look like an email address" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Use at least 8 characters" });
  }

  const taken = db.prepare("SELECT 1 FROM doctors WHERE Email = ?").get(email);
  if (taken) return res.status(409).json({ error: "That email already has an account" });

  const id = randomUUID();
  db.prepare(
    `INSERT INTO doctors (DoctorID, FullName, Email, PasswordHash, CreatedAt)
     VALUES (?,?,?,?,?)`
  ).run(id, fullName, email, bcrypt.hashSync(password, 10), new Date().toISOString());

  // Sign them straight in — making someone type the password again immediately
  // after choosing it is friction with no security value.
  issueSession(res, id, false);

  // A new account starts EMPTY, deliberately. Seeding it with sample cases was
  // friendlier to a judge browsing unattended, but it showed a doctor four
  // already-reviewed patients they had never uploaded — which reads as invented
  // history and undermines the one claim the project rests on. The demo account
  // is where the pre-graded cases live; a real account starts where a real
  // doctor starts.
  res.status(201).json({ id, fullName });
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
  // The screen only offers a method it actually has a map for.
  overlays: [row.HeatmapCamPath && "cam", row.HeatmapCcemPath && "ccem"].filter(Boolean),
});

/**
 * Every assessment saved for a case, oldest first.
 *
 * Only fetched for a single case, never for the worklist — the list needs the
 * current answer, and one query per row to show history nobody is looking at
 * would be the classic N+1.
 */
const reviewHistory = (caseId) =>
  db
    .prepare(
      `SELECT Agreement, CorrectedGrade, Reason, CreatedAt
         FROM reviews WHERE CaseID = ? ORDER BY CreatedAt ASC`
    )
    .all(caseId)
    .map((r) => ({
      agreement: r.Agreement,
      correctedGrade: r.CorrectedGrade,
      reason: r.Reason,
      at: r.CreatedAt,
    }));

app.get("/api/cases", auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, p.Grade, p.HeatmapCamPath, p.HeatmapCcemPath FROM cases c
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
      `SELECT c.*, p.Grade, p.HeatmapCamPath, p.HeatmapCcemPath FROM cases c
       LEFT JOIN predictions p ON p.CaseID = c.CaseID
       WHERE c.CaseID = ? AND c.DoctorID = ?`
    )
    .get(id, doctorId);
}

app.get("/api/cases/:id", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });
  res.json({ ...caseRow(row), reviews: reviewHistory(row.CaseID) });
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
    const { grade, camPath, ccemPath } = await gradeImage(path.resolve(req.file.path));
    db.prepare(
      `INSERT INTO predictions (PredictionID, CaseID, Grade, HeatmapCamPath, HeatmapCcemPath, CreatedAt)
       VALUES (?,?,?,?,?,?)`
    ).run(randomUUID(), id, grade, camPath, ccemPath, new Date().toISOString());
    db.prepare("UPDATE cases SET Status = 'GRADED' WHERE CaseID = ?").run(id);
  } catch (err) {
    console.error("grading failed:", err.message);
    db.prepare("UPDATE cases SET Status = 'FAILED' WHERE CaseID = ?").run(id);
    return res.status(502).json({ id, error: "The grading service did not answer" });
  }

  res.status(201).json(caseRow(ownCase(id, req.doctorId)));
});

/**
 * Re-grade a case whose grading failed.
 *
 * The grading service lives on a shared machine behind a tunnel, so "the model
 * was not reachable when you uploaded" is a normal, temporary condition — not a
 * reason to make the doctor upload the photograph a second time. The image is
 * already on disk; only the prediction is missing.
 *
 * FAILED only. A GRADED case already has a prediction, and re-running the model
 * over it would overwrite the very number BR-4 exists to preserve.
 */
app.post("/api/cases/:id/regrade", auth, async (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });
  if (row.Status !== "FAILED") {
    return res.status(409).json({ error: "Only a case whose grading failed can be re-graded" });
  }

  db.prepare("UPDATE cases SET Status = 'PROCESSING' WHERE CaseID = ?").run(req.params.id);
  try {
    const { grade, camPath, ccemPath } = await gradeImage(path.resolve(row.ImagePath));
    db.prepare(
      `INSERT INTO predictions (PredictionID, CaseID, Grade, HeatmapCamPath, HeatmapCcemPath, CreatedAt)
       VALUES (?,?,?,?,?,?)`
    ).run(randomUUID(), req.params.id, grade, camPath, ccemPath, new Date().toISOString());
    db.prepare("UPDATE cases SET Status = 'GRADED' WHERE CaseID = ?").run(req.params.id);
  } catch (err) {
    console.error("re-grading failed:", err.message);
    db.prepare("UPDATE cases SET Status = 'FAILED' WHERE CaseID = ?").run(req.params.id);
    return res.status(502).json({ error: "The grading service still did not answer" });
  }

  const updated = ownCase(req.params.id, req.doctorId);
  res.json({ ...caseRow(updated), reviews: reviewHistory(req.params.id) });
});

app.post("/api/cases/:id/mark", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });
  // BR-2: reviewable only once the model has produced a grade. A REVIEWED case
  // is still reviewable — a clinician can amend an assessment, and refusing
  // that made a mis-click on a grade 4 eye permanent. What must not happen is
  // the amendment erasing what came before, which is why every submission is
  // appended to `reviews` below.
  if (row.Status !== "GRADED" && row.Status !== "REVIEWED") {
    return res.status(409).json({ error: "This case has no grade to review yet" });
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

  const now = new Date().toISOString();

  // The trail first, so a failure here cannot leave an amendment unrecorded.
  db.prepare(
    `INSERT INTO reviews (ReviewID, CaseID, Agreement, CorrectedGrade, Reason, CreatedAt)
     VALUES (?,?,?,?,?,?)`
  ).run(randomUUID(), req.params.id, agreement, grade, why, now);

  // BR-4: predictions.Grade is never touched.
  db.prepare(
    `UPDATE cases SET Agreement = ?, CorrectedGrade = ?, Reason = ?,
            Status = 'REVIEWED', ReviewedAt = ? WHERE CaseID = ?`
  ).run(agreement, grade, why, now, req.params.id);

  res.json({ ...caseRow(ownCase(req.params.id, req.doctorId)),
             reviews: reviewHistory(req.params.id) });
});

/* --------------------------------------------------------------- files --- */

/**
 * Set Content-Type from the file's magic bytes.
 *
 * Cases uploaded before the storage change above have no extension, so the
 * name cannot be trusted. Two bytes of the file always can: an image served as
 * application/octet-stream is refused by the client, which is the right
 * behaviour there and the wrong outcome here.
 */
function sendImage(res, filePath) {
  const abs = path.resolve(filePath);
  let type = "application/octet-stream";
  try {
    const fd = openSync(abs, "r");
    const head = Buffer.alloc(8);
    readSync(fd, head, 0, 8, 0);
    closeSync(fd);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) type = "image/jpeg";
    else if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      type = "image/png";
  } catch {
    return res.sendStatus(404);
  }
  res.type(type);
  res.sendFile(abs);
}

app.get("/api/cases/:id/image", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.sendStatus(404);
  sendImage(res, row.ImagePath);
});

app.get("/api/cases/:id/heatmap/:method", auth, (req, res) => {
  const column = { cam: "HeatmapCamPath", ccem: "HeatmapCcemPath" }[req.params.method];
  if (!column) return res.status(400).json({ error: "Unknown explanation method" });
  const row = ownCase(req.params.id, req.doctorId);
  if (!row || !row[column]) return res.sendStatus(404);
  sendImage(res, row[column]);
});

/* ---------------------------------------------------------------- misc --- */

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Something went wrong" });
});

app.listen(PORT, async () => {
  console.log(`RetinaX API on http://localhost:${PORT}`);
  // Free hosts wipe the disk on restart. This puts the demo data back.
  //
  // The doctors come first and are not optional: seedDemo() needs an owner for
  // the cases it creates, and with an empty doctors table it skips silently.
  // That is how a deployed instance ends up with no demo accounts and no
  // worklist while the local one looks perfect.
  if (process.env.SEED_DEMO === "1") {
    try {
      const { created, ids } = seedDoctors({ quiet: true });
      if (created) console.log(`[demo] created ${created} demo doctor account(s)`);
      // Seed *for Quang specifically*, not globally. seedDemo() with no doctor
      // counts every case in the table, so once anyone has signed up the count
      // is non-zero and the demo account would be left with an empty worklist.
      await seedDemo({ doctorId: ids[0] });
    } catch (e) { console.warn("[demo]", e.message); }
  }
});
