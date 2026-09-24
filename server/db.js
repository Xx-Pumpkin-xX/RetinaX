import path from "node:path";
import { DATA_DIR } from "./paths.js";

/* ------------------------------------------------------------ the driver ---
 * Two ways to reach the same SQLite file, tried in this order:
 *
 *   1. node:sqlite  — built into Node 22.5+. No install, no compiler.
 *   2. better-sqlite3 — a native addon, for Node 20.x where node:sqlite
 *      does not exist yet.
 *
 * The fallback is what makes `npm install` survive a machine with no C++
 * toolchain: better-sqlite3 only ships prebuilt binaries for Node versions it
 * has seen, so on a very new or very old Node it tries to compile from source
 * and fails with a wall of node-gyp errors about Visual Studio. On any Node
 * from 22.5 up, that package is never even loaded.
 *
 * The two expose the same prepare/get/all/run/exec surface, which is all this
 * app uses.
 * -------------------------------------------------------------------------- */
const DB_FILE = path.join(DATA_DIR, "retinax.db");

async function openDatabase() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const handle = new DatabaseSync(DB_FILE);
    handle.exec("PRAGMA journal_mode = WAL");
    return handle;
  } catch {
    const { default: Database } = await import("better-sqlite3");
    const handle = new Database(DB_FILE);
    handle.pragma("journal_mode = WAL");
    return handle;
  }
}

export const db = await openDatabase();

db.exec(`
CREATE TABLE IF NOT EXISTS doctors (
  DoctorID     TEXT PRIMARY KEY,
  FullName     TEXT NOT NULL,
  Email        TEXT NOT NULL UNIQUE,
  PasswordHash TEXT NOT NULL,
  EmailVerified INTEGER NOT NULL DEFAULT 1,
  VerifyTokenHash TEXT,
  VerifyTokenExpiry TEXT,
  -- Password recovery: two nullable columns, as the class diagram draws it.
  -- Only the SHA-256 *hash* of the token is stored, so a stolen database
  -- cannot be turned back into working reset links, and the expiry is not
  -- optional -- a link that never dies is a permanent back door into an
  -- account that can read fundus images. Clearing the hash on use is what
  -- makes a link single-use.
  ResetTokenHash   TEXT,
  ResetTokenExpiry TEXT,
  CreatedAt    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  CaseID         TEXT PRIMARY KEY,
  DoctorID       TEXT NOT NULL REFERENCES doctors(DoctorID),
  PatientCode    TEXT NOT NULL,
  BirthYear      INTEGER,
  PatientSex     TEXT,
  EyePosition    TEXT NOT NULL,
  ImagePath      TEXT NOT NULL,
  Status         TEXT NOT NULL,
  Agreement      TEXT,
  CorrectedGrade INTEGER,
  Reason         TEXT,
  CreatedAt      TEXT NOT NULL,
  ReviewedAt     TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
  PredictionID TEXT PRIMARY KEY,
  CaseID       TEXT NOT NULL UNIQUE REFERENCES cases(CaseID),
  Grade        INTEGER NOT NULL,
  -- Two explanation maps, because the case screen offers two methods and they
  -- must not be the same picture with different labels. Grad-CAM++ is one
  -- backward pass; CCEM is the fusion of three explainers and is far slower,
  -- so it can legitimately be absent on a freshly uploaded case.
  HeatmapCamPath  TEXT,
  HeatmapCcemPath TEXT,
  CreatedAt    TEXT NOT NULL
);

-- Every assessment a doctor has ever saved for a case, including the ones they
-- later changed their mind about.
--
-- The current values still live on the cases row, so nothing that reads a case
-- has to know this table exists. What it adds is the trail: a clinician can
-- amend an assessment - a mis-click on a grade 4 eye must be correctable - but
-- an amendment must never quietly replace the original, because the
-- disagreement record is the thing this project claims to preserve. Append
-- here, overwrite there.
CREATE TABLE IF NOT EXISTS reviews (
  ReviewID       TEXT PRIMARY KEY,
  CaseID         TEXT NOT NULL REFERENCES cases(CaseID),
  Agreement      TEXT NOT NULL,
  CorrectedGrade INTEGER,
  Reason         TEXT,
  CreatedAt      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_doctor ON cases(DoctorID, CreatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_case ON reviews(CaseID, CreatedAt);
CREATE TABLE IF NOT EXISTS auth_attempts (
  AttemptKey TEXT PRIMARY KEY,
  WindowStartedAt TEXT NOT NULL,
  Attempts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trusted_devices (
  DeviceTokenHash TEXT PRIMARY KEY,
  DoctorID TEXT NOT NULL REFERENCES doctors(DoctorID),
  ExpiresAt TEXT NOT NULL
);
-- Sessions ended before their token expired. A JWT is valid until its own
-- expiry no matter what the server thinks, so signing out can only remove the
-- cookie - the token itself survives anywhere it was copied. One row per
-- signed-out session, dropped once the token would have expired anyway, which
-- is what keeps this table small rather than growing with every sign-out.
CREATE TABLE IF NOT EXISTS revoked_sessions (
  TokenID   TEXT PRIMARY KEY,
  ExpiresAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_verifications (
  VerifyTokenHash TEXT PRIMARY KEY,
  DoctorID TEXT NOT NULL REFERENCES doctors(DoctorID),
  ExpiresAt TEXT NOT NULL,
  KeepSignedIn INTEGER NOT NULL DEFAULT 1
);
`);

/**
 * Add a column to an existing table.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
 * new column never reaches a database that has already been created — and the
 * deployed one holds real work. Checked against PRAGMA rather than attempted
 * and caught, so a genuine failure is still an error rather than swallowed.
 */
function ensureColumn(table, column, declaration) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  console.log(`[schema] added ${table}.${column}`);
}

// When the patient details were last corrected. Null for a case never edited,
// which is most of them.
ensureColumn("cases", "UpdatedAt", "TEXT");

// The attention regions the service marked on this image, as JSON, in the
// photograph's own pixel coordinates - plus the frame they are measured in,
// because a box without its frame is not a location.
//
// Stored rather than recomputed because they belong to the grade that was
// shown: re-running the model to redraw them would risk marking a different
// part of the retina than the doctor saw when they agreed or disagreed.
ensureColumn("predictions", "Regions", "TEXT");
ensureColumn("predictions", "ImageWidth", "INTEGER");
ensureColumn("predictions", "ImageHeight", "INTEGER");
// Why no map was drawn - "grade_0" or "outside_fov". Null when one was.
// The screen has to say which, because a missing overlay with no explanation
// reads as a failure, and this is a finding.
ensureColumn("predictions", "SuppressionReason", "TEXT");
// The six lesion classes as one JSON block. NULL means the lesion models did
// not run for this case, which is a different fact from "found nothing".
ensureColumn("predictions", "Lesions", "TEXT");
ensureColumn("doctors", "EmailVerified", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("doctors", "VerifyTokenHash", "TEXT");
ensureColumn("doctors", "VerifyTokenExpiry", "TEXT");
// Whether the doctor ticked "keep me signed in" on the sign-in that asked for
// this approval. Without it the approval link always issued the long session,
// which is the opposite of a choice.
ensureColumn("login_verifications", "KeepSignedIn", "INTEGER NOT NULL DEFAULT 1");

/**
 * Expired approval links and device trusts are only ever deleted when they are
 * used, so an unused one lives forever. Nothing reads them once past their
 * date; they are just a growing list of hashes tied to real accounts.
 */
const purged =
  db.prepare("DELETE FROM login_verifications WHERE ExpiresAt < ?").run(new Date().toISOString()).changes +
  db.prepare("DELETE FROM trusted_devices WHERE ExpiresAt < ?").run(new Date().toISOString()).changes +
  db.prepare("DELETE FROM revoked_sessions WHERE ExpiresAt < ?").run(new Date().toISOString()).changes;
if (purged) console.log(`[schema] removed ${purged} expired auth token(s)`);

export const GRADE_LABELS = [
  "No DR",
  "Mild NPDR",
  "Moderate NPDR",
  "Severe NPDR",
  "Proliferative DR",
];
