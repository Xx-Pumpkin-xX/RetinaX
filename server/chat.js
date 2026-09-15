/**
 * The assistant, backed by Ollama on the Spark.
 *
 * WHY THIS GOES THROUGH THE API AND NOT STRAIGHT TO CLOUDFLARE
 *
 * Ollama has NO authentication and NO rate limiting. It will answer anybody
 * who can reach port 11434, using a GPU we do not own and models measured in
 * hundreds of gigabytes. Exposing it through a tunnel — even a "temporary"
 * one — hands the whole internet free inference and a way to pin the GPU.
 *
 * So it stays on the private tailnet, exactly like the grading service, and
 * the browser reaches it the same way everything else does:
 *
 *   browser -> Cloudflare Pages Function (/api/*) -> tunnel -> prts-0
 *           -> this module -> Tailscale -> Ollama on the Spark
 *
 * Cloudflare needs no new configuration: its proxy already forwards every
 * /api/* path and already streams response bodies straight through.
 *
 * THREE THINGS THIS MODULE REFUSES TO DELEGATE TO THE CLIENT
 *
 * 1. The model. Pinned server-side. If the browser could name it, any signed-in
 *    user could ask for the 116 GB model and hold the GPU for everyone.
 * 2. The system prompt. Built here, prepended here. A client-supplied system
 *    message would let a user erase the framing that keeps this thing away
 *    from clinical advice.
 * 3. The size. Message count and total characters are capped before anything
 *    leaves this process.
 *
 * Streaming is the default because an answer that takes thirty seconds and
 * arrives all at once looks frozen, and idle proxies in the middle may give up
 * before it lands. Streaming makes bytes flow immediately.
 */
import { Readable } from "node:stream";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.CHAT_MODEL || "qwen3.5:4b";
const TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 120000);

const MAX_MESSAGES = 20;
const MAX_CHARS = 8000;

export const chatConfigured = () => Boolean(process.env.OLLAMA_URL);
export const chatModel = () => MODEL;

const SYSTEM_PROMPT = `You are the assistant inside RetinaX.ai, a diabetic
retinopathy screening tool used by clinicians.

You help people USE THE APPLICATION: how to upload a case, what the statuses
mean, how to record a review, what the heatmap shows and does not show, what
the grades 0-4 are called on the ICDR scale.

You do not give clinical advice. You never suggest a diagnosis, a grade, a
treatment, a referral decision or an urgency for any patient, real or
described. If asked for one, say plainly that you cannot, and that the grade
of record is the clinician's own, made from the image.

You do not interpret a specific patient's images or numbers. You are not a
source of medical information about a person.

Be brief. If you do not know something about this application, say so rather
than inventing a feature.`;

/**
 * Validate and normalise what the browser sent. Only role and content survive,
 * and only from the two roles a client is allowed to speak as — anything else
 * is dropped rather than forwarded to the model host.
 */
function sanitise(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error("messages must be a non-empty array"), { status: 400 });
  }
  const clean = [];
  let chars = 0;
  for (const m of messages.slice(-MAX_MESSAGES)) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = typeof m?.content === "string" ? m.content.trim() : "";
    if (!content) continue;
    chars += content.length;
    if (chars > MAX_CHARS) {
      throw Object.assign(new Error("conversation is too long"), { status: 413 });
    }
    clean.push({ role, content });
  }
  if (clean.length === 0) {
    throw Object.assign(new Error("no usable message content"), { status: 400 });
  }
  return [{ role: "system", content: SYSTEM_PROMPT }, ...clean];
}

async function callOllama(messages, stream) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: sanitise(messages),
      stream,
      // think:false keeps reasoning traces out of the answer. Without it,
      // qwen3.5 returns its whole thinking process in a separate field and
      // some clients render it as the reply.
      think: false,
      options: { temperature: 0.3, num_predict: 600 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw Object.assign(new Error(`assistant unavailable (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`),
                        { status: 502 });
  }
  return res;
}

/** One complete answer. Simpler, but the client waits for the whole thing. */
export async function chatOnce(messages) {
  const res = await callOllama(messages, false);
  const out = await res.json();
  return { reply: out?.message?.content ?? "", model: MODEL };
}

/**
 * Stream the answer. Ollama emits newline-delimited JSON, one object per
 * chunk; it is passed through untouched so the browser can render tokens as
 * they arrive. Piping rather than buffering is the whole point — this is what
 * keeps a slow answer from looking like a hung request.
 */
export async function chatStream(messages, res) {
  const upstream = await callOllama(messages, true);
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // Proxies that buffer would defeat streaming; this asks them not to.
  res.setHeader("X-Accel-Buffering", "no");
  const node = Readable.fromWeb(upstream.body);
  // If the doctor closes the tab mid-answer, stop reading from the GPU.
  res.on("close", () => node.destroy());
  node.pipe(res);
}

/** For /api/health, so status.sh can see whether the assistant is reachable. */
export async function chatReachable() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return false;
    const { models } = await r.json();
    return Array.isArray(models) && models.some((m) => m.name === MODEL);
  } catch {
    return false;
  }
}
