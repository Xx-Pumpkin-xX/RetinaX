import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../api.js";

export default function NewCase() {
  const [form, setForm] = useState({ patientCode: "", birthYear: "", patientSex: "F", eyePosition: "OD" });
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  function pick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) return setError("Choose a fundus photograph first");
    setBusy(true);
    setError(null);
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => fd.append(k, v));
    fd.append("image", file);
    try {
      const created = await api.createCase(fd);
      navigate(`/cases/${created.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="page stack" style={{ gap: 18, maxWidth: 980 }}>
      <div className="stack" style={{ gap: 6 }}>
        <Link to="/cases" className="muted" style={{ fontSize: 13 }}>← My cases</Link>
        <h1 style={{ fontSize: 23, fontWeight: 600, margin: 0 }}>New case</h1>
      </div>

      <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 20 }}>
        <div className="card stack" style={{ padding: 22, gap: 18 }}>
          <div className="stack" style={{ gap: 6 }}>
            <label className="label" htmlFor="pc">Patient code</label>
            <input id="pc" className="input mono" value={form.patientCode} onChange={set("patientCode")}
                   placeholder="VN-0412" required />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="by">Birth year</label>
              <input id="by" className="input mono" value={form.birthYear} onChange={set("birthYear")}
                     placeholder="1968" inputMode="numeric" />
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <label className="label">Sex</label>
              <div className="seg">
                {["M", "F"].map((s) => (
                  <button key={s} type="button" aria-pressed={form.patientSex === s}
                          onClick={() => setForm({ ...form, patientSex: s })} style={{ flex: 1 }}>{s}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <label className="label">Which eye</label>
            <div className="seg">
              {[["OD", "Right eye"], ["OS", "Left eye"]].map(([v, l]) => (
                <button key={v} type="button" aria-pressed={form.eyePosition === v}
                        onClick={() => setForm({ ...form, eyePosition: v })} style={{ flex: 1 }}>
                  {v} · {l}
                </button>
              ))}
            </div>
          </div>

          <div className="disclaimer">
            <span aria-hidden="true">ⓘ</span>
            <div>One case is one eye. To screen both eyes, upload the other photograph as a second case.</div>
          </div>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          <label className="card stack grow"
                 style={{ padding: 22, gap: 14, alignItems: "center", justifyContent: "center",
                          borderStyle: "dashed", cursor: "pointer", minHeight: 300 }}>
            <input type="file" accept="image/jpeg,image/png" onChange={pick} style={{ display: "none" }} />
            {preview ? (
              <>
                <img src={preview} alt="" style={{ maxWidth: 240, maxHeight: 240, borderRadius: "50%" }} />
                <div className="mono" style={{ fontSize: 12.5 }}>{file.name}</div>
                <span style={{ color: "var(--accent)", fontSize: 13 }}>Replace image</span>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600 }}>Choose a fundus photograph</div>
                <div className="muted" style={{ fontSize: 13 }}>JPEG or PNG, up to 12 MB</div>
              </>
            )}
          </label>

          {error && <div className="err">{error}</div>}

          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Grading…" : "Upload and grade"}
          </button>
          <div className="muted" style={{ fontSize: 12.5, textAlign: "center" }}>
            The photograph goes to the grading model straight away.
          </div>
        </div>
      </form>
    </div>
  );
}
