import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, API_BASE, GRADES, gradeVar } from "../api.js";

// "Default" is always available — it is the photograph with nothing on top.
// CAM and CCEM appear only when the service actually returned that map, so the
// control can never offer a method it would then render as a different one.
const METHODS = [
  { key: "cam", label: "CAM" },
  { key: "ccem", label: "CCEM" },
];

export default function CaseDetail() {
  const { id } = useParams();
  const [c, setCase] = useState(null);
  const [error, setError] = useState(null);

  const [overlay, setOverlay] = useState("Default");
  const [opacity, setOpacity] = useState(0.62);

  const [agreement, setAgreement] = useState(null);
  const [corrected, setCorrected] = useState(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    api.case(id)
      .then((row) => {
        setCase(row);
        // Open on the richest explanation this case actually has, rather than
        // on a method that would fall back to a different picture.
        const has = row.overlays || [];
        setOverlay(has.includes("ccem") ? "ccem" : has.includes("cam") ? "cam" : "Default");
      })
      .catch((e) => setError(e.message));
  }, [id]);

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      setCase(await api.mark(id, { agreement, correctedGrade: corrected, reason }));
      setAgreement(null);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="page"><div className="err">{error}</div></div>;
  if (!c) return <div className="page muted">Loading…</div>;

  const available = c.overlays || [];
  const reviewed = c.status === "REVIEWED";
  const canSave = agreement === "AGREE" || (agreement === "DISAGREE" && corrected != null && reason.trim());

  return (
    <div className="page stack" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 4 }}>
          <Link to="/cases" className="muted" style={{ fontSize: 13 }}>← My cases</Link>
          <div className="row" style={{ gap: 12, alignItems: "baseline" }}>
            <span className="mono" style={{ fontSize: 22, fontWeight: 500 }}>{c.patientCode}</span>
            <span className="muted">{c.eye === "OD" ? "Right eye · OD" : "Left eye · OS"}</span>
          </div>
        </div>
        <span className={reviewed ? "pill" : "pill pill-live"}>
          {reviewed ? "Reviewed" : "Awaiting your review"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 18, alignItems: "start" }}>

        {/* ------------------------------------------------------- viewer */}
        <div className="card stack" style={{ overflow: "hidden" }}>
          <div className="viewer" style={{ height: 560 }}>
            <img src={`${API_BASE}/api/cases/${c.id}/image`} alt="Fundus photograph" />
            {overlay !== "Default" && (
              <img className="overlay" src={`${API_BASE}/api/cases/${c.id}/heatmap/${overlay}`}
                   alt={`${overlay.toUpperCase()} explanation overlay`} style={{ opacity }} />
            )}
          </div>
          <div className="row" style={{ gap: 16, padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
            <span style={{ fontSize: 13.5, fontWeight: 500 }}>Overlay</span>
            <div className="seg">
              <button type="button" aria-pressed={overlay === "Default"}
                      onClick={() => setOverlay("Default")}>Default</button>
              {METHODS.filter((m) => available.includes(m.key)).map((m) => (
                <button key={m.key} type="button" aria-pressed={overlay === m.key}
                        onClick={() => setOverlay(m.key)}>{m.label}</button>
              ))}
            </div>
            <input className="grow" type="range" min="0" max="1" step="0.01" value={opacity}
                   onChange={(e) => setOpacity(Number(e.target.value))}
                   disabled={overlay === "Default"} aria-label="Overlay opacity" />
            <span className="mono muted" style={{ fontSize: 12.5, width: 40 }}>
              {Math.round(opacity * 100)}%
            </span>
          </div>
          {available.length === 0 && (
            <div className="muted" style={{ fontSize: 12.5, padding: "0 16px 12px" }}>
              No explanation map was returned for this image.
            </div>
          )}
          {available.length === 1 && available[0] === "cam" && (
            <div className="muted" style={{ fontSize: 12.5, padding: "0 16px 12px" }}>
              Grad-CAM++ only. CCEM fuses three explainers and is computed in a
              batch run, not on upload.
            </div>
          )}
        </div>

        {/* -------------------------------------------------------- panel */}
        <div className="stack" style={{ gap: 14 }}>
          <div className="card" style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "88px 1fr", gap: "6px 10px", fontSize: 13.5 }}>
            <span className="muted">Patient</span><span className="mono">{c.patientCode}</span>
            <span className="muted">Born</span><span>{c.birthYear || "—"} · {c.patientSex || "—"}</span>
          </div>

          <div className="card stack" style={{ padding: 16, gap: 14 }}>
            <div className="label">Model result</div>
            {c.grade == null ? (
              <div className="muted">Not graded.</div>
            ) : (
              <div className="row" style={{ gap: 14 }}>
                <div className="grade-badge"
                     style={{ color: gradeVar(c.grade), borderColor: gradeVar(c.grade),
                              background: "color-mix(in srgb, " + gradeVar(c.grade) + " 12%, transparent)" }}>
                  {c.grade}
                </div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{GRADES[c.grade]}</div>
              </div>
            )}
          </div>

          <div className="disclaimer">
            <span aria-hidden="true">⚠</span>
            <div><strong>Decision support only.</strong> The AI can be wrong — your assessment is
            the diagnosis of record.</div>
          </div>

          {reviewed ? (
            <div className="card stack" style={{ padding: 16, gap: 8 }}>
              <div className="label">Your assessment</div>
              <div style={{ fontWeight: 600 }}>
                {c.agreement === "AGREE"
                  ? `Agreed — grade ${c.grade}`
                  : `Disagreed — corrected to ${c.correctedGrade} · ${GRADES[c.correctedGrade]}`}
              </div>
              {c.reason && <div className="muted" style={{ fontSize: 13.5 }}>{c.reason}</div>}
            </div>
          ) : (
            <div className="card stack" style={{ padding: 16, gap: 13 }}>
              <div className="label">Your assessment</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[["AGREE", "Agree", "--g0"], ["DISAGREE", "Disagree", "--g2"]].map(([v, label, tone]) => (
                  <button key={v} type="button" className="btn btn-ghost"
                          onClick={() => setAgreement(v)}
                          style={{
                            height: 58,
                            borderWidth: agreement === v ? 2 : 1,
                            borderColor: agreement === v ? `var(${tone})` : "var(--line-strong)",
                            background: agreement === v ? `color-mix(in srgb, var(${tone}) 12%, transparent)` : "transparent",
                            fontWeight: agreement === v ? 600 : 500,
                          }}>
                    {label}
                  </button>
                ))}
              </div>

              {agreement === "DISAGREE" && (
                <>
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13 }}>Correct grade</span>
                      {corrected != null && (
                        <span style={{ fontSize: 12, color: gradeVar(corrected) }}>{GRADES[corrected]}</span>
                      )}
                    </div>
                    <div className="seg">
                      {[0, 1, 2, 3, 4].map((g) => (
                        <button key={g} type="button" aria-pressed={corrected === g}
                                onClick={() => setCorrected(g)} style={{ flex: 1, height: 42 }}>{g}</button>
                      ))}
                    </div>
                  </div>

                  <div className="stack" style={{ gap: 6 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13 }}>Reason</span>
                      <span className="label" style={{ color: "var(--danger)" }}>Required</span>
                    </div>
                    <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)}
                              placeholder="What did you see that the model missed?" />
                  </div>
                </>
              )}

              {formError && <div className="err">{formError}</div>}

              <button className="btn" disabled={!canSave || saving} onClick={save}>
                {saving ? "Saving…" : "Save assessment"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
