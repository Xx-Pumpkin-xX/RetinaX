import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { UPLOAD_DIR } from "./paths.js";

const AI_URL = process.env.AI_URL || "http://127.0.0.1:8000";
// The service may be behind a tunnel to a lab machine. A request that never
// answers must not hold an upload open forever.
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45000);
// CCEM fuses three explainers, one of which runs hundreds of masked forward
// passes. It is minutes, not milliseconds, so it gets its own budget — the
// upload timeout is deliberately short because an upload must not hang.
const CCEM_TIMEOUT_MS = Number(process.env.AI_CCEM_TIMEOUT_MS || 600000);

export const aiUrl = () => AI_URL;

/**
 * Send one fundus image to the grading service.
 * Contract:  POST {AI_URL}/infer   multipart field "file"
 *            -> { grade: 0..4,
 *                 heatmap_cam_png_base64:  string | null,   // Grad-CAM++
 *                 heatmap_ccem_png_base64: string | null,   // CCEM fusion
 *                 regions: [{x,y,w,h,polygon,score,rank}],  // attention regions
 *                 image_size: [w, h],                       // their frame
 *                 suppression_reason: string | null }       // why no map
 *
 * Two maps because the case screen offers two methods. CCEM is far more
 * expensive than Grad-CAM++, so it can come back null on a live upload; the
 * screen then offers only the methods that actually exist.
 *
 * The regression score and the Nelder-Mead thresholds stay inside the service.
 */
export async function gradeImage(imageAbsPath, { ccem = false } = {}) {
  const bytes = await readFile(imageAbsPath);
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.basename(imageAbsPath));

  const res = await fetch(`${AI_URL}/infer${ccem ? "?ccem=true" : ""}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(ccem ? CCEM_TIMEOUT_MS : TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AI service ${res.status}`);

  const out = await res.json();
  if (typeof out.grade !== "number") throw new Error("AI service returned no grade");

  const save = async (b64) => {
    if (!b64) return null;
    const p = path.join(UPLOAD_DIR, `${randomUUID()}.png`);
    await writeFile(p, Buffer.from(b64, "base64"));
    return p;
  };

  // Regions are coordinates, not a picture, so they are passed through as data
  // and drawn by the browser. That is the whole point of them: a rendered
  // overlay is fixed at the moment it is made, while an outline can be turned
  // off, zoomed, and laid over the photograph without hiding it.
  const size = Array.isArray(out.image_size) ? out.image_size : [];

  return {
    grade: out.grade,
    camPath: await save(out.heatmap_cam_png_base64),
    ccemPath: await save(out.heatmap_ccem_png_base64),
    regions: Array.isArray(out.regions) ? out.regions : [],
    imageWidth: Number(size[0]) || null,
    imageHeight: Number(size[1]) || null,
    suppressionReason: out.suppression_reason ?? null,
  };
}


/**
 * Redraw the explanation maps for an image that already has a grade.
 *
 * `ccem: false` runs Grad-CAM++ only — one backward pass, a second or two —
 * which is what you want when the renderer changed and the pictures are stale.
 * `ccem: true` also runs the fusion, which is minutes.
 *
 * Separate from gradeImage because the grade must not move: the doctor may
 * already have agreed or disagreed with it, and re-running the model to get a
 * picture would silently rewrite the number that decision was made against.
 * The returned grade is checked against the stored one and otherwise ignored.
 */
export async function explain(imageAbsPath, expectedGrade, { ccem = true } = {}) {
  const { grade, camPath, ccemPath, regions, imageWidth, imageHeight, suppressionReason } =
    await gradeImage(imageAbsPath, { ccem });
  // A suppressed map is an answer, not a failure: the service looked and found
  // nothing worth pointing at. Treating it as an error would make a grade-0 eye
  // look like a broken service, which is exactly the misreading suppression
  // exists to prevent.
  if (!suppressionReason) {
    if (ccem && !ccemPath) throw new Error("The service returned no CCEM map");
    if (!camPath && !ccemPath) throw new Error("The service returned no explanation map");
  }
  if (expectedGrade != null && grade !== expectedGrade) {
    // Same weights and deterministic preprocessing, so this should be
    // impossible. If it ever happens, something changed underneath and the
    // explanation would not be an explanation of the stored grade.
    console.warn(`[ccem] grade drift: stored ${expectedGrade}, service now says ${grade}`);
  }
  // Both maps come back from the one response, so both are returned. A stored
  // heatmap is a rendered picture: change how the service draws them and the
  // old files do not repaint themselves, which is why redrawing has to be
  // something a doctor can ask for.
  return { camPath, ccemPath, regions, imageWidth, imageHeight, suppressionReason };
}
