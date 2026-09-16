import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../api.js";

const EYES = [
  { key: "OD", label: "Right eye", sub: "OD · oculus dexter" },
  { key: "OS", label: "Left eye", sub: "OS · oculus sinister" },
];

/**
 * A patient is screened once; each eye is graded separately.
 *
 * So the details are typed once and each photograph becomes its own case —
 * which keeps the grade an eye-level fact, as it is clinically, without making
 * the doctor fill this form twice for one patient. Uploading one eye is still
 * fine; the other slot is simply left empty.
 */
export default function NewCase() {
  const [form, setForm] = useState({ patientCode: "", birthYear: "", patientSex: "F" });
  const [images, setImages] = useState({ OD: null, OS: null });
  const [previews, setPreviews] = useState({ OD: null, OS: null });
  const [progress, setProgress] = useState({});     // eye -> "grading" | "done" | error text
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  // Có dữ liệu chưa lưu nếu đã gõ patient code / birth year, hoặc đã chọn ảnh cho ít nhất 1 mắt.
  const dirty = Boolean(
    form.patientCode.trim() || form.birthYear.trim() || images.OD || images.OS
  );

  // Đóng tab / reload / gõ URL khác / rời website — trình duyệt tự hỏi xác nhận.
  useEffect(() => {
    function handleBeforeUnload(e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const chosen = EYES.filter((e) => images[e.key]);

  function pick(eye) {
    return (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      setImages((p) => ({ ...p, [eye]: f }));
      setPreviews((p) => ({ ...p, [eye]: URL.createObjectURL(f) }));
      setProgress((p) => ({ ...p, [eye]: undefined }));
    };
  }

  function clear(eye) {
    setImages((p) => ({ ...p, [eye]: null }));
    setPreviews((p) => ({ ...p, [eye]: null }));
    setProgress((p) => ({ ...p, [eye]: undefined }));
  }

  async function submit(e) {
    e.preventDefault();
    if (chosen.length === 0) return setError("Add a photograph for at least one eye");
    setBusy(true);
    setError(null);

    const created = [];
    for (const { key } of chosen) {
      setProgress((p) => ({ ...p, [key]: "grading" }));
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      fd.append("eyePosition", key);
      fd.append("image", images[key]);
      try {
        created.push(await api.createCase(fd));
        setProgress((p) => ({ ...p, [key]: "done" }));
      } catch (err) {
        // One eye failing must not discard the other. Report it against the eye
        // it belongs to and carry on.
        setProgress((p) => ({ ...p, [key]: err.message }));
      }
    }

    if (created.length === 0) {
      setError("Nothing was saved. Check the grading service is running.");
      setBusy(false);
      return;
    }
    navigate(created.length === 1 ? `/cases/${created[0].id}` : "/cases");
  }

  function goToCases(e) {
    if (!dirty) return;
    e.preventDefault();
    if (window.confirm("You have unsaved changes. Leaving this page will discard them. Continue?")) {
      navigate("/cases");
    }
  }

  return (
    <div className="page stack" style={{ gap: 18, maxWidth: 1040 }}>
      <div className="stack" style={{ gap: 6 }}>
        <Link to="/cases" className="muted" style={{ fontSize: 13 }} onClick={goToCases}>← My cases</Link>
        <h1 style={{ fontSize: 23, fontWeight: 600, margin: 0 }}>New case</h1>
      </div>

      <form onSubmit={submit} className="stack" style={{ gap: 18 }}>
        <div className="card stack" style={{ padding: 22, gap: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 14 }}>
            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="pc">Patient code</label>
              <input id="pc" className="input mono" value={form.patientCode} onChange={set("patientCode")}
                     placeholder="VN-0412" required />
            </div>
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

          <div className="disclaimer">
            <span aria-hidden="true">ⓘ</span>
            <div>
              Each eye is graded on its own, so each photograph becomes its own
              case. Add one eye or both — the patient details are shared.
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {EYES.map(({ key, label, sub }) => (
            <div className="stack" key={key} style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <div className="row" style={{ gap: 9 }}>
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>{label}</span>
                  <span className="mono muted" style={{ fontSize: 12 }}>{sub}</span>
                </div>
                {images[key] && !busy && (
                  <button type="button" className="linkish" onClick={() => clear(key)}>Remove</button>
                )}
              </div>

              <label className="card stack grow"
                     style={{ padding: 20, gap: 12, alignItems: "center", justifyContent: "center",
                              borderStyle: "dashed", cursor: busy ? "default" : "pointer", minHeight: 260 }}>
                <input type="file" accept="image/jpeg,image/png" disabled={busy}
                       onChange={pick(key)} style={{ display: "none" }} />
                {previews[key] ? (
                  <>
                    <img src={previews[key]} alt="" style={{ maxWidth: 200, maxHeight: 200, borderRadius: "50%" }} />
                    <div className="mono" style={{ fontSize: 12 }}>{images[key].name}</div>
                    {!busy && <span style={{ color: "var(--accent)", fontSize: 13 }}>Replace</span>}
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Add {label.toLowerCase()}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>JPEG or PNG, up to 12 MB</div>
                    <div className="muted" style={{ fontSize: 12 }}>optional</div>
                  </>
                )}
              </label>

              {progress[key] === "grading" && <div className="note">Grading {label.toLowerCase()}…</div>}
              {progress[key] === "done" && <div className="note">Graded and saved.</div>}
              {progress[key] && !["grading", "done"].includes(progress[key]) && (
                <div className="err">{progress[key]}</div>
              )}
            </div>
          ))}
        </div>

        {error && <div className="err">{error}</div>}

        <div className="stack" style={{ gap: 8, alignItems: "center" }}>
          <button className="btn" type="submit" disabled={busy} style={{ minWidth: 260 }}>
            {busy
              ? "Grading…"
              : chosen.length === 2
                ? "Upload and grade both eyes"
                : chosen.length === 1
                  ? `Upload and grade ${chosen[0].label.toLowerCase()}`
                  : "Upload and grade"}
          </button>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Each photograph goes to the grading model straight away.
          </div>
        </div>
      </form>
    </div>
  );
}