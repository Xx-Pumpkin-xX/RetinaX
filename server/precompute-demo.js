/**
 * Runs every image in demo-images/ through the grading service once and stores
 * the answers next to them, in demo-images/precomputed/.
 *
 * Why this exists: the grading service runs on a lab machine behind a tunnel.
 * The deployed API cannot depend on that machine being awake — and a free host
 * wipes its disk and re-seeds on every restart. With the answers precomputed
 * and committed, the deployed demo comes back up fully populated whether or not
 * the model is reachable.
 *
 * Run it once, locally, with the real model up:
 *     node --env-file=.env precompute-demo.js
 * then commit demo-images/precomputed/.
 */
import { readdir, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { gradeImage, aiUrl } from "./ai.js";

const DIR = "demo-images";
const OUT = path.join(DIR, "precomputed");

const images = (await readdir(DIR)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
if (images.length === 0) {
  console.error(`No images in ${DIR}/. Put 8-12 APTOS / EyePACS photographs there first.`);
  process.exit(1);
}

console.log(`Grading ${images.length} image(s) via ${aiUrl()} …`);
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let ok = 0;
for (const file of images) {
  const stem = path.parse(file).name;
  try {
    const { grade, heatmapPath } = await gradeImage(path.resolve(DIR, file));
    let heatmap = null;
    if (heatmapPath) {
      heatmap = `${stem}.png`;
      await copyFile(heatmapPath, path.join(OUT, heatmap));
    }
    await writeFile(path.join(OUT, `${stem}.json`), JSON.stringify({ grade, heatmap }, null, 2));
    console.log(`  ${file} -> grade ${grade}${heatmap ? " + heatmap" : ""}`);
    ok++;
  } catch (err) {
    console.warn(`  ${file} -> FAILED: ${err.message}`);
  }
}

console.log(`\n${ok}/${images.length} precomputed into ${OUT}/. Commit that folder.`);
process.exit(ok === images.length ? 0 : 1);
