/**
 * Fills the database with demo cases so the app is never empty in front of
 * judges — including after a free-tier host wipes the disk on restart.
 *
 * Drop 8–12 fundus images into server/demo-images/ (APTOS / EyePACS).
 * Runs automatically at boot when SEED_DEMO=1 and there are no cases yet.
 */
import { readdir, copyFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { db } from "./db.js";
import { gradeImage } from "./ai.js";

const SEXES = ["F", "M"];
const EYES = ["OD", "OS"];
const PRECOMPUTED = path.join("demo-images", "precomputed");

/**
 * Ask the live grading service; if it cannot be reached, fall back to the
 * answers committed by `npm run precompute`.
 *
 * The service runs on a lab machine behind a tunnel, and the deployed API
 * re-seeds itself every time the host wipes its disk. Without this fallback the
 * demo would be empty whenever that machine happened to be asleep.
 */
async function gradeOrFallback(destPath, file) {
  try {
    // Seeding is an offline batch, so it can afford CCEM — which is the whole
    // point of the demo cases: they are the ones that show the fused map.
    return { ...(await gradeImage(path.resolve(destPath), { ccem: true })), source: "model" };
  } catch (err) {
    const stem = path.parse(file).name;
    try {
      const saved = JSON.parse(await readFile(path.join(PRECOMPUTED, `${stem}.json`), "utf8"));
      const restore = async (name) => {
        if (!name) return null;
        const dst = path.join("uploads", `${randomUUID()}.png`);
        await copyFile(path.join(PRECOMPUTED, name), dst);
        return dst;
      };
      return {
        grade: saved.grade,
        camPath: await restore(saved.cam),
        ccemPath: await restore(saved.ccem),
        source: "precomputed",
      };
    } catch {
      throw err; // no live service and nothing precomputed — report the real cause
    }
  }
}

/**
 * @param {object}  opts
 * @param {boolean} opts.force     seed even when this doctor already has cases
 * @param {string}  opts.doctorId  whose worklist to fill; defaults to the
 *                                 first seeded doctor. Sign-up passes the new
 *                                 account, so a judge who registers lands on a
 *                                 populated worklist instead of an empty page.
 */
export async function seedDemo({ force = false, doctorId = null } = {}) {
  const count = doctorId
    ? db.prepare("SELECT COUNT(*) n FROM cases WHERE DoctorID = ?").get(doctorId).n
    : db.prepare("SELECT COUNT(*) n FROM cases").get().n;
  if (count > 0 && !force) return { skipped: true, count };

  const doctor = doctorId
    ? { DoctorID: doctorId }
    : db.prepare("SELECT DoctorID FROM doctors ORDER BY CreatedAt LIMIT 1").get();
  if (!doctor) {
    console.warn("[demo] no doctor yet — run `npm run seed` first");
    return { skipped: true };
  }

  let files = [];
  try {
    files = (await readdir("demo-images")).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  } catch {
    console.warn("[demo] no demo-images/ folder — skipping");
    return { skipped: true };
  }
  if (files.length === 0) {
    console.warn("[demo] demo-images/ is empty — drop some fundus photographs in it");
    return { skipped: true };
  }

  let made = 0;
  let usedFallback = 0;
  for (const [i, file] of files.entries()) {
    const src = path.join("demo-images", file);
    const dest = path.join("uploads", `${randomUUID()}${path.extname(file)}`);
    await copyFile(src, dest);

    const id = randomUUID();
    const daysAgo = Math.floor(i / 2);
    const created = new Date(Date.now() - daysAgo * 864e5 - i * 6e5).toISOString();

    db.prepare(
      `INSERT INTO cases (CaseID, DoctorID, PatientCode, BirthYear, PatientSex,
                          EyePosition, ImagePath, Status, CreatedAt)
       VALUES (?,?,?,?,?,?,?,'PROCESSING',?)`
    ).run(id, doctor.DoctorID, `VN-${String(400 + Math.floor(i / 2)).padStart(4, "0")}`,
          1955 + ((i * 7) % 30), SEXES[i % 2], EYES[i % 2], dest, created);

    try {
      const { grade, camPath, ccemPath, source } = await gradeOrFallback(dest, file);
      if (source === "precomputed") usedFallback++;
      db.prepare(
        `INSERT INTO predictions (PredictionID, CaseID, Grade, HeatmapCamPath, HeatmapCcemPath, CreatedAt)
         VALUES (?,?,?,?,?,?)`
      ).run(randomUUID(), id, grade, camPath, ccemPath, created);
      db.prepare("UPDATE cases SET Status='GRADED' WHERE CaseID=?").run(id);

      // Leave the two newest awaiting review so there is something to demo,
      // and mark the older ones — one of them a disagreement.
      if (i < files.length - 2) {
        const disagree = i % 5 === 0 && grade < 4;
        db.prepare(
          `UPDATE cases SET Agreement=?, CorrectedGrade=?, Reason=?, Status='REVIEWED', ReviewedAt=?
           WHERE CaseID=?`
        ).run(
          disagree ? "DISAGREE" : "AGREE",
          disagree ? grade + 1 : null,
          disagree ? "Dot-blot haemorrhages in all four quadrants with venous beading temporally." : null,
          created, id
        );
      }
      made++;
    } catch (err) {
      db.prepare("UPDATE cases SET Status='FAILED' WHERE CaseID=?").run(id);
      console.warn("[demo] grading failed for", file, "-", err.message);
    }
  }
  console.log(
    `[demo] seeded ${made} case(s)` +
    (usedFallback ? ` — ${usedFallback} from precomputed answers (grading service unreachable)` : "")
  );
  return { made };
}

// `node --env-file=.env seed-demo.js` to run it by hand
if (import.meta.url === `file://${process.argv[1]}`) {
  seedDemo({ force: process.argv.includes("--force") }).then(() => process.exit(0));
}
