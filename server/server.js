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
import { gradeImage, explain, aiUrl, chatCase } from "./ai.js";
import { sendMail, isConfigured as mailConfigured } from "./mail.js";
import { seedDemo } from "./seed-demo.js";
import { seedDoctors } from "./seed.js";
import { UPLOAD_DIR } from "./paths.js";
import { VERSION, versionLine } from "./version.js";
import { chatOnce, chatStream, chatReachable, chatModel } from "./chat.js";
import {
  createRateLimiter,
  createBudgetLimiter,
  createConcurrencyLimiter,
  estimateJsonTokens,
  clientIpKey,
  emailKey,
  userKey,
  envInt,
} from "./rate-limit.js";

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:5173";
// The accounts that skip email confirmation and device approval, so the demo
// can be signed into from any machine in the room. Read from the environment
// rather than written here: a hard-coded list in a public repository tells a
// reader exactly which accounts have the weakest door.
const DEMO_EMAILS = new Set(
  String(process.env.DEMO_EMAILS || "quang@retinax.ai")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

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

const DEVICE_COOKIE = "rx_device";
const DEVICE_DAYS = 30;
const LOGIN_VERIFY_MINUTES = 15;

/**
 * A link carries a working token. In production it goes to the mail service and
 * nowhere else: printed here it lands in api.log, which sits beside the vault
 * rather than inside it, and stays readable long after the link expires. In
 * development the link on the console is how you sign in without a mailbox.
 */
function logMailLink(label, email, link, validity) {
  console.log(
    process.env.NODE_ENV === "production"
      ? `[${label}] ${email} - link sent (${validity})`
      : `[${label}] ${email} -> ${link} (${validity})`
  );
}

function issueTrustedDevice(res, doctorId) {
  const deviceToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + DEVICE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO trusted_devices (DeviceTokenHash, DoctorID, ExpiresAt) VALUES (?,?,?)")
    .run(sha256(deviceToken), doctorId, expires);
  res.cookie(DEVICE_COOKIE, deviceToken, {
    ...sessionCookieOptions(),
    maxAge: DEVICE_DAYS * 24 * 60 * 60 * 1000,
  });
}

function hasTrustedDevice(req, doctorId) {
  const token = req.cookies[DEVICE_COOKIE];
  if (!token) return false;
  const device = db.prepare("SELECT * FROM trusted_devices WHERE DeviceTokenHash = ? AND DoctorID = ?")
    .get(sha256(token), doctorId);
  return Boolean(device && new Date(device.ExpiresAt) >= new Date());
}

/* ---------------------------------------------------------- rate limits --- */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const MAIL_WINDOW = 150 * 1000;

// Public/auth routes get both a broad client-IP cap and, where useful, a
// per-identifier cap. The second one is what stops a targeted password attack
// even when many real users share one reverse proxy.
const healthIpLimit = createRateLimiter({
  name: "health",
  windowMs: MINUTE,
  limit: envInt("RATE_HEALTH_IP_MAX", 120),
  key: clientIpKey,
});

const loginIpLimit = createRateLimiter({
  name: "login-ip",
  windowMs: 15 * MINUTE,
  limit: envInt("RATE_LOGIN_IP_MAX", 100),
  key: clientIpKey,
  message: "Too many sign-in attempts from this client. Try again later.",
});

const loginAccountLimit = createRateLimiter({
  name: "login-account-client",
  windowMs: 15 * MINUTE,
  limit: envInt("RATE_LOGIN_ACCOUNT_MAX", 10),
  key: (req) => `${emailKey(req)}:${clientIpKey(req)}`,
  message: "Too many sign-in attempts for this account from this client. Try again later.",
});

const signupIpLimit = createRateLimiter({
  name: "signup",
  windowMs: MAIL_WINDOW,
  limit: envInt("RATE_SIGNUP_IP_MAX", 20),
  key: clientIpKey,
  message: "Too many account creation attempts. Try again later.",
});

const forgotIpLimit = createRateLimiter({
  name: "password-forgot-ip",
  windowMs: MAIL_WINDOW,
  limit: envInt("RATE_FORGOT_IP_MAX", 50),
  key: clientIpKey,
  message: "Too many password reset requests. Try again later.",
});

const forgotAccountLimit = createRateLimiter({
  name: "password-forgot-account",
  windowMs: MAIL_WINDOW,
  limit: envInt("RATE_FORGOT_ACCOUNT_MAX", 5),
  key: emailKey,
  message: "Too many password reset requests for this address. Try again later.",
});

// Both confirmation links are unauthenticated GETs that query the database on
// every hit. The tokens are 32 random bytes, so guessing one is not the worry;
// an unmetered public route is. Generous, because a whole room can share one
// client IP behind the proxy.
const verifyIpLimit = createRateLimiter({
  name: "verify-link",
  windowMs: 15 * MINUTE,
  limit: envInt("RATE_VERIFY_IP_MAX", 120),
  key: clientIpKey,
  message: "Too many confirmation attempts. Try again later.",
});

const resetIpLimit = createRateLimiter({
  name: "password-reset",
  windowMs: 15 * MINUTE,
  limit: envInt("RATE_RESET_IP_MAX", 30),
  key: clientIpKey,
  message: "Too many reset attempts. Try again later.",
});

// Chat is GPU-backed and streams can stay open for minutes. Frequency limits
// stop request spam; concurrency limits stop a burst of parallel streams from
// pinning the model before the per-minute counter becomes useful.
const chatMinuteLimit = createRateLimiter({
  name: "chat-minute",
  windowMs: MINUTE,
  limit: envInt("RATE_CHAT_PER_MINUTE", 12),
  key: userKey,
  message: "Chat request limit reached. Try again in a moment.",
});

const chatHourLimit = createRateLimiter({
  name: "chat-hour",
  windowMs: HOUR,
  limit: envInt("RATE_CHAT_PER_HOUR", 120),
  key: userKey,
  message: "Hourly chat limit reached. Try again later.",
});

// Request count answers "how often?". Token budget answers "how much data?".
// Both chatbot endpoints use the same user-keyed buckets, so switching between
// general chat and case chat cannot reset or bypass the data allowance.
const chatTokenCost = (req) => estimateJsonTokens(req.body);

const chatTokenBudget10m = createBudgetLimiter({
  name: "chat-token-budget-10m",
  windowMs: 10 * MINUTE,
  budget: envInt("RATE_CHAT_TOKEN_BUDGET_10_MIN", 16_000),
  maxCost: envInt("RATE_CHAT_MAX_REQUEST_TOKENS", 4_000),
  cost: chatTokenCost,
  key: userKey,
  headerPrefix: "TokenBudget-10m",
  message: "Chat data budget for the last 10 minutes has been reached.",
  maxCostMessage: "This chat request contains too much text.",
});

const chatTokenBudgetHour = createBudgetLimiter({
  name: "chat-token-budget-hour",
  windowMs: HOUR,
  budget: envInt("RATE_CHAT_TOKEN_BUDGET_HOUR", 64_000),
  cost: chatTokenCost,
  key: userKey,
  headerPrefix: "TokenBudget-Hour",
  message: "Hourly chat data budget has been reached.",
});

const chatUserConcurrency = createConcurrencyLimiter({
  name: "chat-user-concurrency",
  limit: envInt("RATE_CHAT_USER_CONCURRENT", 2),
  key: userKey,
  message: "You already have too many chat replies running.",
});

const chatGlobalConcurrency = createConcurrencyLimiter({
  name: "chat-global-concurrency",
  limit: envInt("RATE_CHAT_GLOBAL_CONCURRENT", 6),
  key: () => "global",
  message: "The assistant is busy. Try again in a moment.",
});

// Grading/explanation routes consume the other GPU service. Keep one expensive
// job per signed-in user and put a modest global ceiling around the model.
const aiUserConcurrency = createConcurrencyLimiter({
  name: "ai-user-concurrency",
  limit: envInt("RATE_AI_USER_CONCURRENT", 1),
  key: userKey,
  message: "Another grading request is already running for your account.",
});

const aiGlobalConcurrency = createConcurrencyLimiter({
  name: "ai-global-concurrency",
  limit: envInt("RATE_AI_GLOBAL_CONCURRENT", 4),
  key: () => "global",
  message: "The grading service is busy. Try again in a moment.",
});

const uploadUserLimit = createRateLimiter({
  name: "case-upload",
  windowMs: 10 * MINUTE,
  limit: envInt("RATE_UPLOAD_PER_10_MIN", 10),
  key: userKey,
  message: "Too many case uploads. Try again later.",
});

const regradeUserLimit = createRateLimiter({
  name: "case-regrade",
  windowMs: 10 * MINUTE,
  limit: envInt("RATE_REGRADE_PER_10_MIN", 6),
  key: userKey,
  message: "Too many re-grade requests. Try again later.",
});

const camExplainLimit = createRateLimiter({
  name: "explain-cam",
  windowMs: 10 * MINUTE,
  limit: envInt("RATE_CAM_EXPLAIN_PER_10_MIN", 12),
  key: userKey,
  skip: (req) => req.query.ccem !== "0",
  message: "Too many explanation redraws. Try again later.",
});

const ccemExplainLimit = createRateLimiter({
  name: "explain-ccem",
  windowMs: HOUR,
  limit: envInt("RATE_CCEM_EXPLAIN_PER_HOUR", 4),
  key: userKey,
  skip: (req) => req.query.ccem === "0",
  message: "CCEM is expensive and its hourly limit has been reached.",
});

/**
 * Liveness probe. Deliberately unauthenticated, because it is what the tunnel,
 * the status script and any uptime checker call before anyone has a session.
 *
 * For that same reason it says nothing an attacker could use: no counts, no
 * file paths, no hostnames, no configuration values. Only booleans and a
 * duration. `model` is the one that matters — the API stays up and serves every
 * existing case when th.
 * e grading service is down; only new uploads fail.
 */
app.get("/api/health", healthIpLimit, async (_req, res) => {
  let model = false;
  try {
    const r = await fetch(`${aiUrl()}/health`, { signal: AbortSignal.timeout(4000) });
    model = r.ok && (await r.json())?.model_loaded === true;
  } catch {
    model = false;
  }
  let database = false;
  try {
    db.prepare("SELECT 1").get();
    database = true;
  } catch {
    database = false;
  }
  const assistant = await chatReachable();

  res.set("Cache-Control", "no-store");
  res.json({
    ok: database,
    ...VERSION,
    database,
    model,
    assistant,
    mail: mailConfigured(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
  });
});

app.post("/api/login", loginIpLimit, loginAccountLimit, async (req, res) => {
  const { email, password, keepSignedIn } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  const doc = db.prepare("SELECT * FROM doctors WHERE Email = ?").get(String(email).toLowerCase().trim());
  if (!doc || !bcrypt.compareSync(password, doc.PasswordHash)) {
    return res.status(401).json({ error: "Wrong email or password" });
  }
  if (!doc.EmailVerified && !DEMO_EMAILS.has(doc.Email)) {
    return res.status(403).json({ error: "Confirm your email address before signing in" });
  }

  if (!DEMO_EMAILS.has(doc.Email) && !hasTrustedDevice(req, doc.DoctorID)) {
    const verifyToken = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + LOGIN_VERIFY_MINUTES * 60 * 1000).toISOString();
    db.prepare("DELETE FROM login_verifications WHERE DoctorID = ?").run(doc.DoctorID);
    db.prepare("INSERT INTO login_verifications (VerifyTokenHash, DoctorID, ExpiresAt, KeepSignedIn) VALUES (?,?,?,?)")
      .run(sha256(verifyToken), doc.DoctorID, expires, keepSignedIn ? 1 : 0);
    const link = `${WEB_ORIGIN}/login/verify?token=${verifyToken}`;
    logMailLink("login verify", doc.Email, link, `valid ${LOGIN_VERIFY_MINUTES} min`);
    await sendMail({
      to: doc.Email,
      subject: "Approve this RetinaX.ai sign-in",
      text: [
        "A sign-in to your RetinaX.ai account was requested from a new browser or device.",
        "",
        "Approve it with this link:",
        link,
        "",
        `This link expires in ${LOGIN_VERIFY_MINUTES} minutes. If this was not you, ignore this email.`,
      ].join("\n"),
    });
    loginAccountLimit.reset(req);
    return res.json({ verificationRequired: true, delivery: mailConfigured() ? "email" : "unconfigured" });
  }

  issueSession(res, doc.DoctorID, keepSignedIn);
  // A correct password clears the account-specific failure bucket so normal
  // repeated sign-ins do not inherit earlier mistakes for the full window.
  loginAccountLimit.reset(req);
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
app.post("/api/signup", signupIpLimit, async (req, res) => {
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
  const verifyToken = randomBytes(32).toString("hex");
  const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO doctors
       (DoctorID, FullName, Email, PasswordHash, EmailVerified, VerifyTokenHash, VerifyTokenExpiry, CreatedAt)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id,
    fullName,
    email,
    bcrypt.hashSync(password, 10),
    0,
    sha256(verifyToken),
    verifyExpiry,
    new Date().toISOString()
  );

  const verifyLink = `${WEB_ORIGIN}/verify?token=${verifyToken}`;
  logMailLink("verify", email, verifyLink, "valid 24 hours");
  await sendMail({
    to: email,
    subject: "Confirm your RetinaX.ai email",
    text: [
      "Welcome to RetinaX.ai.",
      "",
      "Confirm your email address with this link:",
      verifyLink,
      "",
      "This link expires in 24 hours.",
    ].join("\n"),
  });

  // A new account starts EMPTY, deliberately. Seeding it with sample cases was
  // friendlier to a judge browsing unattended, but it showed a doctor four
  // already-reviewed patients they had never uploaded — which reads as invented
  // history and undermines the one claim the project rests on. The demo account
  // is where the pre-graded cases live; a real account starts where a real
  // doctor starts.
  res.status(201).json({
    id,
    fullName,
    verificationRequired: true,
    delivery: mailConfigured() ? "email" : "unconfigured",
  });
});

app.get("/api/email/verify", verifyIpLimit, (req, res) => {
  const token = String(req.query?.token || "");
  const doc = token
    ? db.prepare("SELECT * FROM doctors WHERE VerifyTokenHash = ?").get(sha256(token))
    : null;
  if (!doc || !doc.VerifyTokenExpiry || new Date(doc.VerifyTokenExpiry) < new Date()) {
    return res.status(400).json({ error: "This confirmation link has expired. Request a new one." });
  }

  db.prepare(
    "UPDATE doctors SET EmailVerified = 1, VerifyTokenHash = NULL, VerifyTokenExpiry = NULL WHERE DoctorID = ?"
  ).run(doc.DoctorID);
  res.json({ ok: true });
});

app.get("/api/login/verify", verifyIpLimit, (req, res) => {
  const token = String(req.query?.token || "");
  const verification = token
    ? db.prepare("SELECT * FROM login_verifications WHERE VerifyTokenHash = ?").get(sha256(token))
    : null;
  if (!verification || new Date(verification.ExpiresAt) < new Date()) {
    return res.status(400).json({ error: "This login link has expired. Sign in again to request a new one." });
  }

  db.prepare("DELETE FROM login_verifications WHERE VerifyTokenHash = ?").run(verification.VerifyTokenHash);
  const doctor = db.prepare("SELECT DoctorID, FullName FROM doctors WHERE DoctorID = ?").get(verification.DoctorID);
  if (!doctor) return res.status(400).json({ error: "This login link is no longer valid." });
  issueTrustedDevice(res, doctor.DoctorID);
  // The length of the session was the doctor's choice on the sign-in form, not
  // something approving the link should decide for them.
  issueSession(res, doctor.DoctorID, Boolean(verification.KeepSignedIn));
  res.json({ id: doctor.DoctorID, fullName: doctor.FullName });
});

app.post("/api/logout", (req, res) => {
  // Same attributes as when it was issued, or the browser keeps the cookie.
  //
  // Note what this does and does not do: it removes the cookie from this
  // browser. The JWT inside it stays valid until it expires, so a token
  // already copied elsewhere would still work. Revoking properly needs a
  // server-side denylist, which is the right thing to add before real users.
  res.clearCookie("rx", sessionCookieOptions());

  // Signing out is a statement about this machine, so the machine stops being
  // trusted: the row goes, and the next sign-in from here asks for approval by
  // email again. Leaving it would keep a borrowed laptop trusted for 30 days
  // after the doctor thought they had left.
  const deviceToken = req.cookies[DEVICE_COOKIE];
  if (deviceToken) {
    db.prepare("DELETE FROM trusted_devices WHERE DeviceTokenHash = ?").run(sha256(deviceToken));
    res.clearCookie(DEVICE_COOKIE, sessionCookieOptions());
  }
  res.sendStatus(204);
});

/* ----------------------------------------------------- password reset --- */

// The token is random, single-use and expires. Only its SHA-256 hash is stored,
// so a leaked database cannot be turned back into working reset links.
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const RESET_MINUTES = 30;

app.post("/api/password/forgot", forgotIpLimit, forgotAccountLimit, async (req, res) => {
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
    logMailLink("reset", email, link, `valid ${RESET_MINUTES} min`);

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

app.post("/api/password/reset", resetIpLimit, (req, res) => {
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

/**
 * `full` adds the attention regions, which are polygons and can run to a few
 * kilobytes per case. The worklist shows fifty rows and draws none of them, so
 * it asks for the lean shape; only the case screen pays for the coordinates.
 */
const caseRow = (row, full = false) => ({
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
  ...(full ? {
    // Marked areas in the photograph's own pixels, with the frame they are
    // measured in. Parsed here so a corrupt row degrades to "no regions"
    // rather than breaking the whole case screen.
    regions: parseRegions(row.Regions),
    imageSize: row.ImageWidth && row.ImageHeight
      ? { width: row.ImageWidth, height: row.ImageHeight }
      : null,
    suppressionReason: row.SuppressionReason ?? null,
    lesions: parseLesions(row.Lesions),
  } : {}),
});

// Null when the column is empty or unreadable, so the screen can say "not
// assessed" rather than inventing six negative findings out of a missing row.
function parseLesions(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && Array.isArray(v.classes) ? v : null;
  } catch {
    return null;
  }
}

function parseRegions(json) {
  if (!json) return [];
  try {
    const out = JSON.parse(json);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

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

/**
 * The assistant. Behind `auth` deliberately: Ollama has no authentication of
 * its own and a GPU behind it, so the session cookie is the only thing between
 * the open internet and free inference on someone else's hardware.
 *
 * Streams by default. `?stream=0` returns one JSON answer instead, which is
 * easier to debug with curl.
 */
app.post("/api/chat", auth, chatMinuteLimit, chatHourLimit, chatTokenBudget10m, chatTokenBudgetHour, chatUserConcurrency, chatGlobalConcurrency, async (req, res) => {
  const { messages } = req.body || {};
  const wantsStream = req.query.stream !== "0";
  try {
    if (wantsStream) {
      await chatStream(messages, res);
    } else {
      res.set("Cache-Control", "no-store");
      res.json(await chatOnce(messages));
    }
  } catch (err) {
    console.error("[chat]", err.message);
    // Once streaming has begun the status line is already sent, so the only
    // honest thing left is to end the stream.
    if (res.headersSent) return res.end();
    res.status(err.status || 502).json({ error: err.message || "assistant unavailable" });
  }
});

app.get("/api/cases", auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, p.Grade, p.HeatmapCamPath, p.HeatmapCcemPath FROM cases c
       LEFT JOIN predictions p ON p.CaseID = c.CaseID
       WHERE c.DoctorID = ? ORDER BY c.CreatedAt DESC`
    )
    .all(req.doctorId);
  res.json(rows.map((r) => caseRow(r)));
});

// BR-1: a doctor only ever sees their own cases. 404, not 403 —
// 403 would confirm that someone else's case exists.
function ownCase(id, doctorId) {
  return db
    .prepare(
      // The region columns are here and not in the worklist query above,
      // because only the case screen draws them and they are polygons.
      `SELECT c.*, p.Grade, p.HeatmapCamPath, p.HeatmapCcemPath,
              p.Regions, p.ImageWidth, p.ImageHeight, p.SuppressionReason,
              p.Lesions
         FROM cases c
         LEFT JOIN predictions p ON p.CaseID = c.CaseID
        WHERE c.CaseID = ? AND c.DoctorID = ?`
    )
    .get(id, doctorId);
}

app.get("/api/cases/:id", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });
  res.json({ ...caseRow(row, true), reviews: reviewHistory(row.CaseID) });
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

function isInvalidImageError(err) {
  return (
    err?.status === 422 &&
    [
      "INVALID_IMAGE",
      "INVALID_FUNDUS_IMAGE",
      "UNCERTAIN_FUNDUS_IMAGE",
    ].includes(err?.code)
  );
}

/**
 * One patient code, one photograph per eye.
 *
 * A patient has two eyes, so a code may carry at most an OD and an OS. A
 * second image of the same eye under the same code is how a worklist ends up
 * with two grades for one eye and no way to tell which one the clinician
 * meant. Corrections have their own route; a second upload is not one.
 *
 * FAILED rows are exempt: they hold no grade, and dropSupersededFailures
 * exists precisely to clear them once a retry works.
 */
function eyeTaken(doctorId, patientCode, eye, exceptCaseId = null) {
  return db
    .prepare(
      `SELECT CaseID FROM cases
        WHERE DoctorID = ? AND PatientCode = ? AND EyePosition = ?
          AND Status <> 'FAILED' AND CaseID <> ?`
    )
    .get(doctorId, patientCode, eye, exceptCaseId ?? "");
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

app.post("/api/cases", auth, uploadUserLimit, aiUserConcurrency, aiGlobalConcurrency, upload.single("image"), async (req, res) => {
  const { patientSex } = req.body || {};
  const patientCode = String(req.body?.patientCode ?? "").trim();
  const eyePosition = String(req.body?.eyePosition ?? "").trim().toUpperCase();
  const birthYear = Number(String(req.body?.birthYear ?? "").trim());
  const thisYear = new Date().getFullYear();

  // Every rejection below has to drop the upload too, or the disk fills with
  // images no case row points at.
  const reject = async (status, payload) => {
    await removeFile(req.file?.path);
    return res.status(status).json(payload);
  };

  if (!req.file) return res.status(400).json({ error: "An image is required" });
  if (!patientCode) return reject(400, { error: "A patient code is required" });
  if (patientCode.length > 64) return reject(400, { error: "That patient code is too long" });
  if (!["OD", "OS"].includes(eyePosition)) {
    return reject(400, { error: "Eye must be OD (right) or OS (left)" });
  }
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > thisYear) {
    return reject(400, { error: `Year of birth must be between 1900 and ${thisYear}` });
  }
  if (eyeTaken(req.doctorId, patientCode, eyePosition)) {
    return reject(409, {
      error: `${patientCode} already has a ${eyePosition === "OD" ? "right" : "left"} eye image`,
      code: "DUPLICATE_EYE",
      patientCode,
      eyePosition,
    });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cases (CaseID, DoctorID, PatientCode, BirthYear, PatientSex,
                        EyePosition, ImagePath, Status, CreatedAt)
     VALUES (?,?,?,?,?,?,?,'PROCESSING',?)`
  ).run(id, req.doctorId, patientCode, birthYear,
        patientSex || null, eyePosition, req.file.path, now);

  try {
    const { grade, camPath, ccemPath, regions, imageWidth, imageHeight, suppressionReason, lesions } =
      await gradeImage(path.resolve(req.file.path));
    db.prepare(
      `INSERT INTO predictions (PredictionID, CaseID, Grade, HeatmapCamPath, HeatmapCcemPath,
                                Regions, ImageWidth, ImageHeight, SuppressionReason, Lesions, CreatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(randomUUID(), id, grade, camPath, ccemPath, JSON.stringify(regions),
          imageWidth, imageHeight, suppressionReason,
          lesions ? JSON.stringify(lesions) : null, new Date().toISOString());
    db.prepare("UPDATE cases SET Status = 'GRADED' WHERE CaseID = ?").run(id);
    await dropSupersededFailures(req.doctorId, patientCode, eyePosition, id);
  
  } catch (err) {
    console.error("grading failed:", err.message);

    // Invalid image/fundus is a user input problem,
    // not a failure of the grading service.
    if (isInvalidImageError(err)) {
      db.prepare(
        "DELETE FROM cases WHERE CaseID = ?"
      ).run(id);

      await removeFile(req.file.path);

      return res.status(422).json({
        error: err.message,
        code: err.code,
        fundusScore: err.fundusScore ?? null,
        fundusStatus: err.fundusStatus ?? null,
      });
    }

    // Real AI/service failure.
    db.prepare(
      "UPDATE cases SET Status = 'FAILED' WHERE CaseID = ?"
    ).run(id);

    return res.status(502).json({
      id,
      error: "The grading service did not answer",
    });
  }

  res.status(201).json(caseRow(ownCase(id, req.doctorId), true));
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
app.post("/api/cases/:id/regrade", auth, regradeUserLimit, aiUserConcurrency, aiGlobalConcurrency, async (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });
  if (row.Status !== "FAILED") {
    return res.status(409).json({ error: "Only a case whose grading failed can be re-graded" });
  }

  db.prepare("UPDATE cases SET Status = 'PROCESSING' WHERE CaseID = ?").run(req.params.id);
  try {
    const { grade, camPath, ccemPath, regions, imageWidth, imageHeight, suppressionReason, lesions } =
      await gradeImage(path.resolve(row.ImagePath));
    db.prepare(
      `INSERT INTO predictions (PredictionID, CaseID, Grade, HeatmapCamPath, HeatmapCcemPath,
                                Regions, ImageWidth, ImageHeight, SuppressionReason, Lesions, CreatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(randomUUID(), req.params.id, grade, camPath, ccemPath, JSON.stringify(regions),
          imageWidth, imageHeight, suppressionReason,
          lesions ? JSON.stringify(lesions) : null, new Date().toISOString());
    db.prepare("UPDATE cases SET Status = 'GRADED' WHERE CaseID = ?").run(req.params.id);
    await dropSupersededFailures(req.doctorId, row.PatientCode, row.EyePosition, req.params.id);
    
  } catch (err) {
    console.error("re-grading failed:", err.message);

    // This is an existing case, so do NOT delete the case or image.
    // Restore it to FAILED so the state is internally consistent.
    db.prepare(
      "UPDATE cases SET Status = 'FAILED' WHERE CaseID = ?"
    ).run(req.params.id);

    if (isInvalidImageError(err)) {
      return res.status(422).json({
        error: err.message,
        code: err.code,
        fundusScore: err.fundusScore ?? null,
        fundusStatus: err.fundusStatus ?? null,
      });
    }

    return res.status(502).json({
      error: "The grading service still did not answer",
    });
  }
  
  const updated = ownCase(req.params.id, req.doctorId);
  res.json({ ...caseRow(updated, true), reviews: reviewHistory(req.params.id) });
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
app.post("/api/cases/:id/explain", auth, camExplainLimit, ccemExplainLimit, aiUserConcurrency, aiGlobalConcurrency, async (req, res) => {
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
    const { camPath, ccemPath, regions, imageWidth, imageHeight, suppressionReason, lesions } =
      await explain(path.resolve(row.ImagePath), row.Grade, { ccem: wantCcem });
    // COALESCE on both, so a Grad-CAM++-only redraw keeps an existing CCEM map
    // rather than deleting it. The grade is not touched — BR-4 — only pictures.
    db.prepare(
      `UPDATE predictions
          SET HeatmapCamPath  = COALESCE(?, HeatmapCamPath),
              HeatmapCcemPath = COALESCE(?, HeatmapCcemPath),
              Regions           = ?,
              ImageWidth        = ?,
              ImageHeight       = ?,
              SuppressionReason = ?,
              Lesions           = COALESCE(?, Lesions)
        WHERE CaseID = ?`
    // Lesions is COALESCEd, unlike Regions: a redraw that ran no lesion
    // models must not erase a block an earlier run produced.
    // Regions are overwritten rather than COALESCEd: they were just recomputed
    // from this image, and keeping the previous set would leave the screen
    // marking areas the current map no longer supports.
    ).run(camPath, ccemPath, JSON.stringify(regions), imageWidth, imageHeight,
          suppressionReason, lesions ? JSON.stringify(lesions) : null, req.params.id);

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
  res.json({ ...caseRow(updated, true), reviews: reviewHistory(req.params.id) });
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

  // A year outside this range is a typo, not a patient. Rejecting it here
  // beats a worklist quietly sorted by an impossible age.
  const birthYear = Number(String(rawYear ?? "").trim());
  const thisYear = new Date().getFullYear();
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > thisYear) {
    return res.status(400).json({ error: `Year of birth must be between 1900 and ${thisYear}` });
  }

  if (eyeTaken(req.doctorId, patientCode, eyePosition, req.params.id)) {
    return res.status(409).json({
      error: `${patientCode} already has a ${eyePosition === "OD" ? "right" : "left"} eye image`,
      code: "DUPLICATE_EYE",
    });
  }

  const changed = [];
  if (row.PatientCode !== patientCode) changed.push(`code ${row.PatientCode} -> ${patientCode}`);
  if (row.EyePosition !== eyePosition) changed.push(`eye ${row.EyePosition} -> ${eyePosition}`);
  if ((row.BirthYear ?? null) !== birthYear) changed.push(`born ${row.BirthYear ?? "—"} -> ${birthYear ?? "—"}`);
  if ((row.PatientSex ?? null) !== patientSex) changed.push(`sex ${row.PatientSex ?? "—"} -> ${patientSex ?? "—"}`);
  if (!changed.length) {
    return res.json({ ...caseRow(row, true), reviews: reviewHistory(row.CaseID) });
  }

  db.prepare(
    `UPDATE cases SET PatientCode = ?, BirthYear = ?, PatientSex = ?, EyePosition = ?,
            UpdatedAt = ? WHERE CaseID = ?`
  ).run(patientCode, birthYear, patientSex, eyePosition, new Date().toISOString(), req.params.id);

  // Logged because a patient code is how this image is matched to a person in
  // the clinic's own records. Changing one is not a formatting tweak.
  console.log(`[details] ${req.params.id.slice(0, 8)} by ${req.doctorId.slice(0, 8)}: ${changed.join(", ")}`);

  const updated = ownCase(req.params.id, req.doctorId);
  res.json({ ...caseRow(updated, true), reviews: reviewHistory(req.params.id) });
});

/**
 * Delete a case and everything belonging to it.
 *
 * This removes the prediction, review rows, photograph and both heatmaps.
 * ownCase ensures that doctors can delete only their own cases.
 */
app.delete("/api/cases/:id", auth, async (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);
  if (!row) return res.status(404).json({ error: "Case not found" });

  // A reviewed case carries a clinical record, so it takes a second, explicit
  // signal to remove one. 428 rather than 409: this is not "you may not", it
  // is "say it again on purpose". The dialog in the browser already sends it,
  // so the only request this stops is the one nobody meant to make - a stray
  // click, a retry, a bare curl.
  if (row.Status === "REVIEWED" && req.body?.confirm !== "DELETE-REVIEWED") {
    return res.status(428).json({
      error: "This case has a recorded assessment. Confirm the deletion to proceed.",
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

  // The grade and the assessment are logged BECAUSE they are about to stop
  // existing anywhere else. If a case goes by accident, this line is what is
  // left of it.
  console.log(
    `[delete] case ${req.params.id.slice(0, 8)} (${row.Status}) by ${req.doctorId.slice(0, 8)}` +
    (row.Status === "REVIEWED"
      ? ` grade=${row.Grade} agreement=${row.Agreement} corrected=${row.CorrectedGrade ?? "-"}`
      : "")
  );
  res.sendStatus(204);
});

app.post("/api/cases/:id/mark", auth, (req, res) => {
  const row = ownCase(req.params.id, req.doctorId);

  if (!row) {
    return res.status(404).json({
      error: "Case not found",
    });
  }

  // A case can only be reviewed once the model has produced a grade.
  // REVIEWED cases may also be amended; every submission is preserved
  // in the reviews table.
  if (
    row.Status !== "GRADED" &&
    row.Status !== "REVIEWED"
  ) {
    return res.status(409).json({
      error: "This case has no grade to review yet",
    });
  }

  const {
    agreement,
    correctedGrade,
    reason,
  } = req.body || {};

  if (
    !["AGREE", "DISAGREE"].includes(agreement)
  ) {
    return res.status(400).json({
      error:
        "agreement must be AGREE or DISAGREE",
    });
  }

  let grade = null;

  // `Reason` is reused:
  //
  // AGREE    -> optional clinician note
  // DISAGREE -> required disagreement reason
  let why = String(reason || "").trim() || null;

  if (agreement === "DISAGREE") {
    grade = Number(correctedGrade);

    if (
      !Number.isInteger(grade) ||
      grade < 0 ||
      grade > 4
    ) {
      return res.status(400).json({
        error:
          "A corrected grade of 0-4 is required",
      });
    }

    if (!why) {
      return res.status(400).json({
        error:
          "A reason is required when you disagree",
      });
    }
  }

  const now = new Date().toISOString();

  // Preserve every clinician assessment in the review history.
  db.prepare(
    `INSERT INTO reviews
       (ReviewID, CaseID, Agreement, CorrectedGrade, Reason, CreatedAt)
     VALUES (?,?,?,?,?,?)`
  ).run(
    randomUUID(),
    req.params.id,
    agreement,
    grade,
    why,
    now
  );

  // Important: predictions.Grade is NEVER changed.
  db.prepare(
    `UPDATE cases
        SET Agreement = ?,
            CorrectedGrade = ?,
            Reason = ?,
            Status = 'REVIEWED',
            ReviewedAt = ?
      WHERE CaseID = ?`
  ).run(
    agreement,
    grade,
    why,
    now,
    req.params.id
  );

  res.json({
    ...caseRow(
      ownCase(
        req.params.id,
        req.doctorId
      )
    ),

    reviews: reviewHistory(
      req.params.id
    ),
  });
});

/* --------------------------------------------------------- contestable AI --- */

app.post(
  "/api/cases/:id/chat",
  auth,
  chatMinuteLimit,
  chatHourLimit,
  chatTokenBudget10m,
  chatTokenBudgetHour,
  chatUserConcurrency,
  chatGlobalConcurrency,
  async (req, res) => {
    const row = ownCase(
      req.params.id,
      req.doctorId
    );

    if (!row) {
      return res.status(404).json({
        error: "Case not found",
      });
    }

    // The clinician must first save an assessment.
    //
    // Both AGREE and DISAGREE can use the chatbot.
    if (
      row.Status !== "REVIEWED" ||
      !["AGREE", "DISAGREE"].includes(
        row.Agreement
      )
    ) {
      return res.status(409).json({
        error:
          "Save your assessment before starting the AI discussion.",
      });
    }

    const message = String(
      req.body?.message || ""
    ).trim();

    const history = Array.isArray(
      req.body?.history
    )
      ? req.body.history.slice(-8)
      : [];

    if (!message) {
      return res.status(400).json({
        error: "A message is required",
      });
    }

    if (message.length > 4000) {
      return res.status(400).json({
        error: "The message is too long",
      });
    }

    try {
      /*
       * IMPORTANT:
       *
       * The browser does NOT tell the chatbot:
       * - the AI grade
       * - whether the doctor agreed
       * - the corrected grade
       * - the doctor's saved note/reason
       *
       * Those values come from our database.
       *
       * The browser only supplies the current chat message
       * and previous conversation messages.
       */

      const correctedGrade =
        row.CorrectedGrade == null
          ? null
          : Number(row.CorrectedGrade);

      const reply = await chatCase({
        model_grade: Number(row.Grade),

        model_label:
          GRADE_LABELS[row.Grade],

        agreement:
          row.Agreement,

        corrected_grade:
          correctedGrade,

        corrected_label:
          correctedGrade == null
            ? null
            : GRADE_LABELS[
                correctedGrade
              ],

        doctor_note:
          row.Reason || "",

        message,

        history: history.map(
          (item) => ({
            role:
              item.role === "assistant"
                ? "assistant"
                : "user",

            content: String(
              item.content ??
              item.text ??
              ""
            ).slice(0, 3000),
          })
        ),
      });

      console.log(
        `[chat] case ${req.params.id.slice(
          0,
          8
        )} ` +
        `${row.Agreement} ` +
        `by ${req.doctorId.slice(
          0,
          8
        )}`
      );

      res.json({
        reply,
      });

    } catch (err) {
      console.error(
        "[chat]",
        err
      );

      res.status(502).json({
        error:
          "The contestable AI could not answer. Please try again.",
      });
    }
  }
);

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
  console.log(`[boot] build ${versionLine()} — ${VERSION.packedBy}`);
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
