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

export const GRADE_LABELS = [
  "No DR",
  "Mild NPDR",
  "Moderate NPDR",
  "Severe NPDR",
  "Proliferative DR",
];
