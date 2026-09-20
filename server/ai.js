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
const CCEM_TIMEOUT_MS = Number(
  process.env.AI_CCEM_TIMEOUT_MS || 600000
);

// The local chatbot normally answers quickly, but loading the Ollama model
// after it has gone idle can take several seconds.
const CHAT_TIMEOUT_MS = Number(
  process.env.AI_CHAT_TIMEOUT_MS || 90000
);

export const aiUrl = () => AI_URL;

/**
 * Send one fundus image to the grading service.
 *
 * Contract:
 *   POST {AI_URL}/infer
 *   multipart field "file"
 *
 *   -> {
 *        grade: 0..4,
 *        heatmap_cam_png_base64: string | null,
 *        heatmap_ccem_png_base64: string | null,
 *        regions: [{x,y,w,h,polygon,score,rank}],
 *        image_size: [w, h],
 *        suppression_reason: string | null
 *      }
 *
 * Two maps because the case screen offers two methods. CCEM is far more
 * expensive than Grad-CAM++, so it can come back null on a live upload; the
 * screen then offers only the methods that actually exist.
 *
 * The regression score and the Nelder-Mead thresholds stay inside the service.
 */
export async function gradeImage(
  imageAbsPath,
  { ccem = false } = {}
) {
  const bytes = await readFile(imageAbsPath);

  const form = new FormData();

  form.append(
    "file",
    new Blob([bytes]),
    path.basename(imageAbsPath)
  );

  const res = await fetch(
    `${AI_URL}/infer${ccem ? "?ccem=true" : ""}`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(
        ccem ? CCEM_TIMEOUT_MS : TIMEOUT_MS
      ),
    }
  );

  const out = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(
      out.message ||
      out.error ||
      `AI service ${res.status}`
    );

  err.status = res.status;
  err.code = out.error || "AI_SERVICE_ERROR";

  err.fundusScore =
    out.fundus_score ?? null;

  err.fundusStatus =
    out.fundus_status ?? null;

  throw err;
}

  if (typeof out.grade !== "number") {
    throw new Error(
      "AI service returned no grade"
    );
  }

  const save = async (b64) => {
    if (!b64) return null;

    const p = path.join(
      UPLOAD_DIR,
      `${randomUUID()}.png`
    );

    await writeFile(
      p,
      Buffer.from(b64, "base64")
    );

    return p;
  };

  // Regions are coordinates, not a picture, so they are passed through as data
  // and drawn by the browser. That is the whole point of them: a rendered
  // overlay is fixed at the moment it is made, while an outline can be turned
  // off, zoomed, and laid over the photograph without hiding it.
  const size = Array.isArray(out.image_size)
    ? out.image_size
    : [];

  return {
    grade: out.grade,

    camPath: await save(
      out.heatmap_cam_png_base64
    ),

    ccemPath: await save(
      out.heatmap_ccem_png_base64
    ),

    regions: Array.isArray(out.regions)
      ? out.regions
      : [],

    imageWidth:
      Number(size[0]) || null,

    imageHeight:
      Number(size[1]) || null,

    suppressionReason:
      out.suppression_reason ?? null,

    // Null, not an empty block, when the service ran no lesion models. The
    // difference is the whole point: "not looked for" is not "not there".
    lesions: out.lesions ?? null,
  };
}


/**
 * Redraw the explanation maps for an image that already has a grade.
 *
 * `ccem: false` runs Grad-CAM++ only — one backward pass, a second or two —
 * which is what you want when the renderer changed and the pictures are stale.
 *
 * `ccem: true` also runs the fusion, which is minutes.
 *
 * Separate from gradeImage because the grade must not move: the doctor may
 * already have agreed or disagreed with it, and re-running the model to get a
 * picture would silently rewrite the number that decision was made against.
 * The returned grade is checked against the stored one and otherwise ignored.
 */
export async function explain(
  imageAbsPath,
  expectedGrade,
  { ccem = true } = {}
) {
  const {
    grade,
    camPath,
    ccemPath,
    regions,
    imageWidth,
    imageHeight,
    suppressionReason,
    lesions,
  } = await gradeImage(
    imageAbsPath,
    { ccem }
  );

  // A suppressed map is an answer, not a failure: the service looked and found
  // nothing worth pointing at. Treating it as an error would make a grade-0 eye
  // look like a broken service, which is exactly the misreading suppression
  // exists to prevent.
  if (!suppressionReason) {
    if (ccem && !ccemPath) {
      throw new Error(
        "The service returned no CCEM map"
      );
    }

    if (!camPath && !ccemPath) {
      throw new Error(
        "The service returned no explanation map"
      );
    }
  }

  if (
    expectedGrade != null &&
    grade !== expectedGrade
  ) {
    // Same weights and deterministic preprocessing, so this should be
    // impossible. If it ever happens, something changed underneath and the
    // explanation would not be an explanation of the stored grade.
    console.warn(
      `[ccem] grade drift: stored ${expectedGrade}, service now says ${grade}`
    );
  }

  // Both maps come back from the one response, so both are returned. A stored
  // heatmap is a rendered picture: change how the service draws them and the
  // old files do not repaint themselves, which is why redrawing has to be
  // something a doctor can ask for.
  return {
    camPath,
    ccemPath,
    regions,
    imageWidth,
    imageHeight,
    suppressionReason,
    lesions,
  };
}


/**
 * Send a clinician/model discussion to the contestable-AI endpoint
 * on the DGX.
 *
 * The DGX FastAPI service then talks to Ollama locally:
 *
 *   Node/Express
 *       -> {AI_URL}/chat
 *       -> DGX FastAPI
 *       -> 127.0.0.1:11434
 *       -> Ollama / qwen3.5:4b
 *
 * `payload` should have the same structure expected by the DGX /chat endpoint:
 *
 * {
 *   model_grade,
 *   model_label,
 *   agreement,
 *   corrected_grade,
 *   corrected_label,
 *   doctor_note,
 *   message,
 *   history
 * }
 */
export async function chatCase(payload) {
  const res = await fetch(
    `${AI_URL}/chat`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify(payload),

      signal: AbortSignal.timeout(
        CHAT_TIMEOUT_MS
      ),
    }
  );

  if (!res.ok) {
    const text = await res
      .text()
      .catch(() => "");

    throw new Error(
      `AI chat service ${res.status}: ${text.slice(0, 300)}`
    );
  }

  const out = await res.json();

  if (
    !out.reply ||
    typeof out.reply !== "string"
  ) {
    throw new Error(
      "AI chat service returned no reply"
    );
  }

  return out.reply.trim();
}
