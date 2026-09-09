import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "node:path";
import { openSync, readSync, closeSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { db, GRADE_LABELS } from "./db.js";
import { gradeImage, explain } from "./ai.js";
import { sendMail, isConfigured as mailConfigured } from "./mail.js";
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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
/**
 * The session cookie's attributes, in one place.
 *
 * Setting and clearing MUST use identical values. A browser will not let a
 * cookie marked Secure be overwritten by a Set-Cookie that is not — the rule
 * exists so that a network attacker on a plain-HTTP page cannot tamper with a
 * cookie the HTTPS site set. So a clearCookie() with the attributes left off
 * is silently ignored: sign-out appears to work, and the session is still
 * there on the next reload.
 */
function sessionCookieOptions() {
  const cross = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: cross ? "none" : "lax",
    secure: cross,
    path: "/",
  };
}

function issueSession(res, doctorId, keepSignedIn) {
  const days = keepSignedIn ? 14 : 1;
  const token = jwt.sign({ sub: doctorId }, SECRET, { expiresIn: `${days}d` });
  res.cookie("rx", token, {
    ...sessionCookieOptions(),
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
  // Same attributes as when it was issued, or the browser keeps the cookie.
  //
  // Note what this does and does not do: it removes the cookie from this
  // browser. The JWT inside it stays valid until it expires, so a token
  // already copied elsewhere would still work. Revoking properly needs a
  // server-side denylist, which is the right thing to add before real users.
  res.clearCookie("rx", sessionCookieOptions());
  res.sendStatus(204);
});

/* ----------------------------------------------------- password reset --- */

// The token is random, single-use and expires. Only its SHA-256 hash is stored,
// so a leaked database cannot be turned back into working reset links.
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const RESET_MINUTES = 30;

app.post("/api/password/forgot", async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  const doc = email ? db.prepare("SELECT DoctorID FROM doctors WHERE Email = ?").get(email) : null;

  if (doc) {
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + RESET_MINUTES * 60 * 1000).toISOString();
    // Issuing a new link invalidates any previous one, because there is only
    // ever one hash on the row.
    db.prepare("UPDATE doctors SET ResetTokenHash = ?, ResetTokenExpiry = ? WHERE DoctorID = ?")
      .run(sha256(token), expires, doc.DoctorID);

    const link = `${WEB_ORIGIN}/reset?token=${token}`;

    // Logged either way. When mail is configured this is the audit trail for a
    // reset that was requested; when it is not, it is the only way to complete
    // one, and someone running the demo needs to be able to find it.
    console.log(`[reset] ${email} -> ${link} (valid ${RESET_MINUTES} min)`);

    await sendMail({
      to: email,
      subject: "Reset your RetinaX.ai password",
      text: [
        "Someone asked to reset the password for this RetinaX.ai account.",
        "",
        `Open this link to choose a new one. It works once and expires in ${RESET_MINUTES} minutes:`,
        link,
        "",
        "If this was not you, ignore this message — nothing has changed.",
      ].join("\n"),
    });
  }

  // The answer never depends on whether the address exists: a difference here
  // tells an attacker which doctors have accounts. `delivery` describes the
  // server's configuration, which is the same for everyone, so it is safe to
  // report — and it is the difference between "check your inbox" and a screen
  // that promises an email nothing will ever send.
  res.json({ ok: true, delivery: mailConfigured() ? "email" : "unconfigured" });
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
  updatedAt: row.UpdatedAt ?? null,
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

/** Delete a file we are done with, without letting that break the request. */
async function removeFile(p) {
  if (!p) return;
  try {
    await unlink(path.resolve(p));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[cleanup] could not remove", p, err.message);
  }
}

/**
 * Drop earlier failed attempts at the same eye once one of them works.
 *
 * A failed case holds nothing a clinician can use — no grade, no explanation,
 * no assessment. It exists so the failure is visible and retryable. Once the
 * same eye has been graded, the old attempts are just noise in the worklist,
 * and noise in a worklist is not free: a row that says "grading failed" next
 * to one that succeeded invites a second look at a patient who has already
 * been dealt with.
 *
 * Deliberately narrow: same doctor, same patient code, same eye, and only rows
 * that are FAILED. A case that reached any other status is somebody's work.
 */
async function dropSupersededFailures(doctorId, patientCode, eye, keepCaseId) {
  const stale = db
    .prepare(
      `SELECT CaseID, ImagePath FROM cases
        WHERE DoctorID = ? AND PatientCode = ? AND EyePosition = ?
          AND Status = 'FAILED' AND CaseID <> ?`
    )
    .all(doctorId, patientCode, eye, keepCaseId);
  if (!stale.length) return 0;

  const del = db.prepare("DELETE FROM cases WHERE CaseID = ?");
  for (const row of stale) {
    del.run(row.CaseID);
    await removeFile(row.ImagePath);
  }
  console.log(`[cleanup] removed ${stale.length} superseded failed case(s) for ${patientCode} ${eye}`);
  return stale.length;
}

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
    await dropSupersededFailures(req.doctorId, patientCode.trim(), eyePosition, id);
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
    await dropSupersededFailures(req.doctorId, row.PatientCode, row.EyePosition, req.params.id);
  } catch (err) {
    console.error("re-grading failed:", err.message);
    db.prepare("UPDATE cases SET Status = 'FAILED' WHERE CaseID = ?").run(req.params.id);
    return res.status(502).json({ error: "The grading service still did not answer" });
  }

  const updated = ownCase(req.params.id, req.doctorId);
  res.json({ ...caseRow(updated), reviews: reviewHistory(req.params.id) });
});

/**
 * Compute the CCEM map for a case that already has one.
 *
 * On demand rather than on upload. CCEM fuses Grad-CAM++, Ada-SISE and
 * SmoothIG and takes minutes on a GPU; running it inside the upload request
 * would mean every doctor waits for an explanation most of them will not open.
 * So the upload gets Grad-CAM++, and the fused map is a thing you ask for.
 *
 * The stored grade is never touched — see explainCcem.
 */
app.post("/api/cases/:id/explain", auth, async (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });
  if (row.Grade == null) {
    return res.status(409).json({ error: "This case has no grade to explain yet" });
  }
  // ?ccem=0 redraws Grad-CAM++ only: one backward pass rather than minutes of
  // fusion, which is what you want when the renderer changed and the stored
  // pictures are stale.
  const wantCcem = req.query.ccem !== "0";

  try {
    const { camPath, ccemPath } =
      await explain(path.resolve(row.ImagePath), row.Grade, { ccem: wantCcem });
    // COALESCE on both, so a Grad-CAM++-only redraw keeps an existing CCEM map
    // rather than deleting it. The grade is not touched — BR-4 — only pictures.
    db.prepare(
      `UPDATE predictions
          SET HeatmapCamPath  = COALESCE(?, HeatmapCamPath),
              HeatmapCcemPath = COALESCE(?, HeatmapCcemPath)
        WHERE CaseID = ?`
    ).run(camPath, ccemPath, req.params.id);

    // Only once the row points at the new files: a crash between writing them
    // and committing the row would otherwise leave the case pointing at a map
    // that no longer exists. Orphans are cheap; a broken reference is not.
    if (camPath) await removeFile(row.HeatmapCamPath);
    if (ccemPath) await removeFile(row.HeatmapCcemPath);
  } catch (err) {
    console.error("explain failed:", err.message);
    return res.status(502).json({ error: `The grading service could not redraw the explanation: ${err.message}` });
  }

  const updated = ownCase(req.params.id, req.doctorId);
  res.json({ ...caseRow(updated), reviews: reviewHistory(req.params.id) });
});

/**
 * Correct the patient details on a case.
 *
 * A mistyped patient code or the wrong eye chosen from the dropdown is a
 * clerical error, and there was no way to fix one — the case had to be
 * uploaded again, which produced a duplicate and left the wrong one in the
 * worklist.
 *
 * What can be corrected is exactly the data the doctor typed. What cannot:
 *
 *   the photograph   changing it would make the grade an answer to a
 *                    different question
 *   the grade        BR-4 — it is the model's measurement
 *   the assessment   it has its own history and its own route
 *
 * So this is deliberately not a general "edit case" endpoint. It names four
 * columns and touches nothing else.
 */
app.post("/api/cases/:id/details", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });

  const patientCode = String(req.body?.patientCode ?? "").trim();
  const eyePosition = String(req.body?.eyePosition ?? "").trim().toUpperCase();
  const rawYear = req.body?.birthYear;
  const patientSex = req.body?.patientSex ? String(req.body.patientSex).trim().toUpperCase() : null;

  if (!patientCode) return res.status(400).json({ error: "A patient code is required" });
  if (patientCode.length > 64) return res.status(400).json({ error: "That patient code is too long" });
  if (!["OD", "OS"].includes(eyePosition)) {
    return res.status(400).json({ error: "Eye must be OD (right) or OS (left)" });
  }
  if (patientSex && !["F", "M"].includes(patientSex)) {
    return res.status(400).json({ error: "Sex must be F or M, or left blank" });
  }

  let birthYear = null;
  if (rawYear !== null && rawYear !== undefined && String(rawYear).trim() !== "") {
    birthYear = Number(rawYear);
    const thisYear = new Date().getFullYear();
    // A year outside this range is a typo, not a patient. Rejecting it here
    // beats a worklist quietly sorted by an impossible age.
    if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > thisYear) {
      return res.status(400).json({ error: `Year of birth must be between 1900 and ${thisYear}` });
    }
  }

  const changed = [];
  if (row.PatientCode !== patientCode) changed.push(`code ${row.PatientCode} -> ${patientCode}`);
  if (row.EyePosition !== eyePosition) changed.push(`eye ${row.EyePosition} -> ${eyePosition}`);
  if ((row.BirthYear ?? null) !== birthYear) changed.push(`born ${row.BirthYear ?? "—"} -> ${birthYear ?? "—"}`);
  if ((row.PatientSex ?? null) !== patientSex) changed.push(`sex ${row.PatientSex ?? "—"} -> ${patientSex ?? "—"}`);
  if (!changed.length) {
    return res.json({ ...caseRow(row), reviews: reviewHistory(row.CaseID) });
  }

  db.prepare(
    `UPDATE cases SET PatientCode = ?, BirthYear = ?, PatientSex = ?, EyePosition = ?,
            UpdatedAt = ? WHERE CaseID = ?`
  ).run(patientCode, birthYear, patientSex, eyePosition, new Date().toISOString(), req.params.id);

  // Logged because a patient code is how this image is matched to a person in
  // the clinic's own records. Changing one is not a formatting tweak.
  console.log(`[details] ${req.params.id.slice(0, 8)} by ${req.doctorId.slice(0, 8)}: ${changed.join(", ")}`);

  const updated = ownCase(req.params.id, req.doctorId);
  res.json({ ...caseRow(updated), reviews: reviewHistory(req.params.id) });
});

/**
 * Delete a case.
 *
 * Only a case nobody has assessed. A REVIEWED case carries a clinician's
 * recorded judgement, and the disagreement between that judgement and the
 * model's grade is the thing this whole system exists to preserve — offering a
 * button that quietly destroys one would undo the argument the project makes.
 * So: FAILED, PROCESSING and GRADED can go; REVIEWED is refused, with a reason.
 *
 * That still covers the case this exists for. A failed upload holds nothing at
 * all: no grade, no explanation, no decision. It is litter in a worklist, and
 * litter in a worklist costs attention.
 *
 * Everything belonging to the case goes with it — the prediction, any review
 * rows, the photograph and both heatmaps — because a half-deleted case is
 * worse than either outcome.
 */
app.delete("/api/cases/:id", auth, async (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });

  if (row.Status === "REVIEWED") {
    return res.status(409).json({
      error: "This case has been reviewed. A recorded assessment is a clinical record and is not deleted here.",
    });
  }

  // Rows first: if the unlinks fail we are left with unreferenced files, which
  // is untidy. The reverse order leaves a case pointing at nothing, which is a
  // bug the doctor sees.
  db.prepare("DELETE FROM reviews WHERE CaseID = ?").run(req.params.id);
  db.prepare("DELETE FROM predictions WHERE CaseID = ?").run(req.params.id);
  db.prepare("DELETE FROM cases WHERE CaseID = ?").run(req.params.id);

  await removeFile(row.ImagePath);
  await removeFile(row.HeatmapCamPath);
  await removeFile(row.HeatmapCcemPath);

  console.log(`[delete] case ${req.params.id.slice(0, 8)} (${row.Status}) by ${req.doctorId.slice(0, 8)}`);
  res.sendStatus(204);
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
  // Match the client's no-store: an image that was once served with the wrong
  // content type must not be able to come back from a cache after the fix.
  res.setHeader("Cache-Control", "no-store");
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
  // Nothing can still be grading after a restart: the request that was waiting
  // on the model died with the previous process. Left alone, such a case sits
  // at PROCESSING for ever — the screen polls, the spinner never resolves, and
  // there is no way out, because retrying is offered only on a failed case.
  // Marking them failed is both true and actionable.
  const stuck = db
    .prepare("UPDATE cases SET Status = 'FAILED' WHERE Status = 'PROCESSING'")
    .run();
  if (stuck.changes) {
    console.log(`[boot] ${stuck.changes} case(s) were still PROCESSING — marked FAILED, retryable`);
  }

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
