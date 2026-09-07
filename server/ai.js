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
 *            -> { grade: 0..4, heatmap_png_base64: string | null }
 * The regression score and the Nelder-Mead thresholds stay inside the service.
 */
export async function gradeImage(imageAbsPath) {
  const bytes = await readFile(imageAbsPath);
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.basename(imageAbsPath));

  const res = await fetch(`${AI_URL}/infer`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AI service ${res.status}`);

  const out = await res.json();
  if (typeof out.grade !== "number") throw new Error("AI service returned no grade");

  let heatmapPath = null;
  if (out.heatmap_png_base64) {
    heatmapPath = path.join("uploads", `${randomUUID()}.png`);
    await writeFile(heatmapPath, Buffer.from(out.heatmap_png_base64, "base64"));
  }
  return { grade: out.grade, heatmapPath };
}
