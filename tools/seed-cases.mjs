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

async function api(pathname, { method = "GET", body, json } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (json) headers["Content-Type"] = "application/json";
  const res = await fetch(API + pathname, { method, headers, body: json ? JSON.stringify(json) : body });
  const set = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
  for (const c of set) if (c.startsWith("rx=")) cookie = c.split(";")[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function upload(file, patient, eye) {
  const bytes = await readFile(path.join(DIR, file));
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), file);
  form.append("patientCode", patient.code);
  form.append("birthYear", String(patient.birthYear));
  form.append("patientSex", patient.sex);
  form.append("eyePosition", eye);
  return api("/api/cases", { method: "POST", body: form });
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
  if (!r.ok) { console.log(`upload failed (${r.status}) ${JSON.stringify(r.data)}`); made.push(null); continue; }
  console.log(`grade ${r.data.grade}`);
  made.push(r.data);
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
