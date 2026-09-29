import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const API      = process.env.API      || "http://localhost:3000";
const EMAIL    = process.env.EMAIL    || "quang@retinax.ai";
const PASSWORD = process.env.PASSWORD || "retinax123";
const DIR      = process.env.IMAGES   || path.join(process.env.HOME, "server", "demo-images");

const PATIENTS = [
  { code: "VN-0401", birthYear: 1962, sex: "M" },
  { code: "VN-0402", birthYear: 1975, sex: "F" },
  { code: "VN-0403", birthYear: 1958, sex: "M" },
  { code: "VN-0404", birthYear: 1981, sex: "F" },
  { code: "VN-0405", birthYear: 1969, sex: "M" },
  { code: "VN-0406", birthYear: 1954, sex: "F" },
  { code: "VN-0407", birthYear: 1987, sex: "M" },
];

const PLAN = [
  "agree", "agree",
  "agree", "disagree",
  "agree", "agree",
  "disagree", "agree",
  "agree", "agree",
  "none",  "none",
  "none",  "leave",
];

let cookie = "";

// fetch() returns a result for every HTTP answer, however bad, but THROWS when
// the connection itself fails - which is what a pooled keep-alive socket does
// when the server's idle timeout wins the race. Thrown, it killed the whole run
// at case 6 and the remaining eight were never attempted. Caught here, it
// becomes an ordinary failed result the caller can decide about.
const isNetworkError = (e) =>
  ["UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(e?.cause?.code ?? e?.code)
  || /fetch failed/i.test(String(e?.message ?? ""));

async function api(pathname, { method = "GET", body, json } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (json) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(API + pathname, { method, headers, body: json ? JSON.stringify(json) : body });
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    return { ok: false, status: 0, data: String(e.cause?.code ?? e.message), networkError: true };
  }
  const set = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
  for (const c of set) if (c.startsWith("rx=")) cookie = c.split(";")[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

function buildForm(bytes, file, patient, eye) {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), file);
  form.append("patientCode", patient.code);
  form.append("birthYear", String(patient.birthYear));
  form.append("patientSex", patient.sex);
  form.append("eyePosition", eye);
  return form;
}

async function upload(file, patient, eye) {
  const bytes = await readFile(path.join(DIR, file));
  // A fresh form each attempt: fetch consumes the body, so a retry cannot reuse it.
  const send = () => api("/api/cases", { method: "POST", body: buildForm(bytes, file, patient, eye) });

  let r = await send();
  if (r.networkError) {
    // The socket died without an answer, so whether the case was created is
    // genuinely unknown. Asking again settles it: the second attempt either
    // creates the case, or is refused with DUPLICATE_EYE - which is proof the
    // first one did land, and the eye guard is what makes the retry safe.
    await new Promise((done) => setTimeout(done, 1500));
    r = await send();
    if (r.status === 409 && r.data?.code === "DUPLICATE_EYE") {
      const list = await api("/api/cases");
      const found = (Array.isArray(list.data) ? list.data : [])
        .find((c) => c.patientCode === patient.code && c.eye === eye);
      if (found) return { ok: true, status: 200, data: found, recovered: true };
    }
  }
  return r;
}

const files = (await readdir(DIR)).filter((f) => /\.png$/i.test(f)).sort().slice(0, 14);
if (files.length < 14) {
  console.error(`need 14 PNGs in ${DIR}, found ${files.length}`);
  process.exit(1);
}

const login = await api("/api/login", { method: "POST", json: { email: EMAIL, password: PASSWORD } });
if (!login.ok) { console.error("login failed:", login.status, login.data); process.exit(1); }
console.log("signed in as", login.data.fullName, "\n");

const made = [];
for (let i = 0; i < 14; i++) {
  const patient = PATIENTS[Math.floor(i / 2)];
  const eye = i % 2 === 0 ? "OD" : "OS";
  process.stdout.write(`${String(i + 1).padStart(2)}/14  ${patient.code} ${eye}  ${files[i]}  ... `);
  const r = await upload(files[i], patient, eye);
  if (!r.ok) {
    console.log(`FAILED (${r.status || "connection dropped"}) ${JSON.stringify(r.data)}`);
    made.push(null);
    continue;
  }
  console.log(`grade ${r.data.grade}${r.recovered ? "   (recovered after a dropped connection)" : ""}`);
  made.push(r.data);
}

// One eye that fails is not a reason to abandon the other thirteen, but it is a
// reason to say so plainly at the end rather than leave it in the scrollback.
const missed = made
  .map((c, i) => (c ? null : `${String(i + 1).padStart(2)}/14  ${files[i]}`))
  .filter(Boolean);
if (missed.length) {
  console.log(`\n${missed.length} of 14 did not upload:`);
  for (const m of missed) console.log("  " + m);
} else {
  console.log("\nall 14 uploaded");
}

console.log();
for (let i = 0; i < 14; i++) {
  const c = made[i];
  if (!c || PLAN[i] === "none" || PLAN[i] === "leave") continue;
  const json = PLAN[i] === "agree"
    ? { agreement: "AGREE" }
    : { agreement: "DISAGREE",
        correctedGrade: c.grade >= 4 ? 3 : c.grade + 1,
        reason: "Further haemorrhages visible superotemporally; graded one step higher." };
  const r = await api(`/api/cases/${c.id}/mark`, { method: "POST", json });
  console.log(`${c.patientCode} ${c.eye}  ${PLAN[i]}  ${r.ok ? "ok" : `error ${r.status} ${JSON.stringify(r.data)}`}`);
}

const last = made[13];
if (last) {
  console.log("\nTo turn the last case into a grading failure (gives the demo a working Re-grade button):");
  console.log(`sqlite3 ~/retinax-data/data/retinax.db "DELETE FROM predictions WHERE CaseID='${last.id}'; UPDATE cases SET Status='FAILED' WHERE CaseID='${last.id}';"`);
}
