import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const AI_URL = process.env.AI_URL || "http://127.0.0.1:8000";
// The service may be behind a tunnel to a lab machine. A request that never
// answers must not hold an upload open forever.
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45000);

export const aiUrl = () => AI_URL;

/**
 * Send one fundus image to the grading service.
 * Contract:  POST {AI_URL}/infer   multipart field "file"
 *            -> { grade: 0..4,
 *                 heatmap_cam_png_base64:  string | null,   // Grad-CAM++
 *                 heatmap_ccem_png_base64: string | null }  // CCEM fusion
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AI service ${res.status}`);

  const out = await res.json();
  if (typeof out.grade !== "number") throw new Error("AI service returned no grade");

  const save = async (b64) => {
    if (!b64) return null;
    const p = path.join("uploads", `${randomUUID()}.png`);
    await writeFile(p, Buffer.from(b64, "base64"));
    return p;
  };

  return {
    grade: out.grade,
    camPath: await save(out.heatmap_cam_png_base64),
    ccemPath: await save(out.heatmap_ccem_png_base64),
  };
}
