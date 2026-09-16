import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, GRADES, gradeVar } from "../api.js";
import ApiImage from "../ApiImage.jsx";
import RegionOverlay from "../RegionOverlay.jsx";

// "Default" is always available — it is the photograph with nothing on top.
// CAM and CCEM appear only when the service actually returned that map, so the
// control can never offer a method it would then render as a different one.
const when = (iso) =>
  new Date(iso).toLocaleString("en-GB",
    { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const METHODS = [
  { key: "cam", label: "CAM" },
  { key: "ccem", label: "CCEM" },
];

// Why the service drew no map. Said out loud, because an overlay control that
// silently offers nothing reads as a broken service, and this is a finding.
const SUPPRESSED = {
  grade_0: "No retinopathy was found, so there is nothing for an explanation to point at. A map drawn here would mark noise.",
  outside_fov: "Most of the model's attention fell outside the retina — on the crop edge or the black border — so the map describes the photograph, not the eye. It has not been shown.",
  no_map: "The service returned no explanation map for this image.",
};

export default function CaseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [c, setCase] = useState(null);
  const [error, setError] = useState(null);

  const [overlay, setOverlay] = useState("Default");
  const [opacity, setOpacity] = useState(0.62);

  const [agreement, setAgreement] = useState(null);
  const [corrected, setCorrected] = useState(null);
  const [reason, setReason] = useState("");

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatting, setChatting] = useState(false);
  const [chatError, setChatError] = useState(null);
  
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [regrading, setRegrading] = useState(false);
  const [amending, setAmending] = useState(false);
  const [explaining, setExplaining] = useState(false); // false | "cam" | "ccem"
  const [editing, setEditing] = useState(null);        // null, or a draft of the details
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [explainError, setExplainError] = useState(null);

  useEffect(() => {
    let alive = true;
    let timer;

    function load() {
      api.case(id)
        .then((row) => {
          if (!alive) return;
          setCase(row);
          // Open on the richest explanation this case actually has, rather than
          // on a method that would fall back to a different picture.
          const has = row.overlays || [];
          setOverlay(
            row.regions?.length ? "regions"
              : has.includes("ccem") ? "ccem"
              : has.includes("cam") ? "cam"
              : "Default"
          );
          // A case can be mid-grading when the page opens, or be re-graded from
          // another tab. Without this the doctor sits on a stale "Grading…"
          // until they think to refresh.
          if (row.status === "PROCESSING") timer = setTimeout(load, 2000);
        })
        .catch((e) => alive && setError(e.message));
    }

    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [id]);

  async function removeCase() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteCase(id);
      navigate("/cases", { replace: true });
    } catch (err) {
      setDeleteError(err.message);
      setDeleting(false);
    }
  }

  async function saveDetails(e) {
    e.preventDefault();
    setSavingDetails(true);
    setDetailsError(null);
    try {
      setCase(await api.updateDetails(id, editing));
      setEditing(null);
    } catch (err) {
      setDetailsError(err.message);
    } finally {
      setSavingDetails(false);
    }
  }

  async function redraw({ ccem }) {
    setExplaining(ccem ? "ccem" : "cam");
    setExplainError(null);
    try {
      const updated = await api.explain(id, { ccem });
      setCase(updated);
      setOverlay(ccem ? "ccem" : "cam");
    } catch (err) {
      setExplainError(err.message);
    } finally {
      setExplaining(false);
    }
  }

  async function regrade() {
    setRegrading(true);
    setFormError(null);
    try {
      setCase(await api.regrade(id));
    } catch (err) {
      setFormError(err.message);
      setCase(await api.case(id));   // the server put it back to FAILED
    } finally {
      setRegrading(false);
    }
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      setCase(await api.mark(id, { agreement, correctedGrade: corrected, reason }));
      setAgreement(null);
      setCorrected(null);
      setReason("");
      setAmending(false);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="page"><div className="err">{error}</div></div>;
  if (!c) return <div className="page muted">Loading…</div>;

  const available = c.overlays || [];
  const regions = c.regions || [];
  const suppressed = c.suppressionReason ? SUPPRESSED[c.suppressionReason] : null;
  const reviewed = c.status === "REVIEWED";
  const graded = c.status === "GRADED";
  const processing = c.status === "PROCESSING";
  const failed = c.status === "FAILED";
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
        <span className={graded ? "pill pill-live" : "pill"}
              style={failed ? { color: "var(--g4)", borderColor: "var(--g4)" } : undefined}>
          {reviewed ? "Reviewed"
            : graded ? "Awaiting your review"
            : processing ? "Grading…"
            : "Grading failed"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 18, alignItems: "start" }}>

        {/* ------------------------------------------------------- viewer */}
        <div className="card stack" style={{ overflow: "hidden" }}>
          <div className="viewer" style={{ height: 560 }}>
            <ApiImage path={`/api/cases/${c.id}/image`} alt="Fundus photograph" />
            {overlay === "regions" && (
              <RegionOverlay regions={regions} size={c.imageSize} />
            )}
            {overlay !== "Default" && overlay !== "regions" && (
              <ApiImage className="overlay" path={`/api/cases/${c.id}/heatmap/${overlay}`}
                        alt={`${overlay.toUpperCase()} explanation overlay`} style={{ opacity }} />
            )}
          </div>
          <div className="row" style={{ gap: 16, padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
            <span style={{ fontSize: 13.5, fontWeight: 500 }}>Overlay</span>
            <div className="seg">
              <button type="button" aria-pressed={overlay === "Default"}
                      onClick={() => setOverlay("Default")}>Default</button>
              {regions.length > 0 && (
                <button type="button" aria-pressed={overlay === "regions"}
                        onClick={() => setOverlay("regions")}
                        title="The strongest areas of the model's attention, outlined over the photograph">
                  Regions
                </button>
              )}
              {METHODS.filter((m) => available.includes(m.key)).map((m) => (
                <button key={m.key} type="button" aria-pressed={overlay === m.key}
                        onClick={() => setOverlay(m.key)}>{m.label}</button>
              ))}
            </div>
            <input className="grow" type="range" min="0" max="1" step="0.01" value={opacity}
                   onChange={(e) => setOpacity(Number(e.target.value))}
                   disabled={overlay === "Default" || overlay === "regions"}
                   aria-label="Overlay opacity" />
            <span className="mono muted" style={{ fontSize: 12.5, width: 40 }}>
              {Math.round(opacity * 100)}%
            </span>
          </div>
          {available.length === 0 && (
            <div className="muted" style={{ fontSize: 12.5, padding: "0 16px 12px" }}>
              {suppressed || "No explanation map was returned for this image."}
            </div>
          )}
          {overlay === "regions" && (
            <div className="muted" style={{ fontSize: 12.5, padding: "0 16px 12px", lineHeight: 1.5 }}>
              {regions.length} area{regions.length > 1 ? "s" : ""} where the model's evidence for
              grade {c.grade} was strongest. These are{" "}
              <strong>attention regions, not detected lesions</strong> — the outline shows where
              the grading model looked, and is deliberately wider than any lesion inside it.
            </div>
          )}
          {c.grade != null && (
            <div className="stack" style={{ gap: 8, padding: "0 16px 14px" }}>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                {available.includes("ccem")
                  ? "CCEM fuses Grad-CAM++, Ada-SISE and SmoothIG, weighted by agreement. Redrawing re-renders the overlay from the current model without changing the grade."
                  : "Grad-CAM++ only. CCEM fuses three explainers — Grad-CAM++, Ada-SISE and SmoothIG — weighted by agreement, and takes a few minutes on the GPU, so it is computed when you ask rather than on every upload."}
              </div>
              {explainError && <div className="err">{explainError}</div>}
              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <button className="btn btn-ghost" onClick={() => redraw({ ccem: false })}
                        disabled={Boolean(explaining)}
                        title="Re-runs Grad-CAM++ and redraws the overlay. The grade is not recomputed.">
                  {explaining === "cam" ? "Redrawing…" : "Redraw overlay"}
                </button>
                <button className="btn btn-ghost" onClick={() => redraw({ ccem: true })}
                        disabled={Boolean(explaining)}>
                  {explaining === "ccem"
                    ? "Computing… (a few minutes)"
                    : available.includes("ccem") ? "Recompute CCEM" : "Compute CCEM"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* -------------------------------------------------------- panel */}
        <div className="stack" style={{ gap: 14 }}>
          {/* Patient details are typed by a person, so a person can correct
              them. The photograph, the grade and the assessment history are
              not editable here — those are records, not data entry. */}
          {editing ? (
            <form className="card stack" style={{ padding: 16, gap: 12 }} onSubmit={saveDetails}>
              <div className="label">Correct patient details</div>

              <div className="stack" style={{ gap: 6 }}>
                <label className="label" htmlFor="ed-code">Patient code</label>
                <input id="ed-code" className="input mono" value={editing.patientCode} required
                       onChange={(e) => setEditing({ ...editing, patientCode: e.target.value })} />
              </div>

              <div className="row" style={{ gap: 10 }}>
                <div className="stack grow" style={{ gap: 6 }}>
                  <label className="label" htmlFor="ed-year">Year of birth</label>
                  <input id="ed-year" className="input" type="number" inputMode="numeric"
                         min="1900" max={new Date().getFullYear()} value={editing.birthYear}
                         onChange={(e) => setEditing({ ...editing, birthYear: e.target.value })} />
                </div>
                <div className="stack" style={{ gap: 6, width: 96 }}>
                  <label className="label" htmlFor="ed-sex">Sex</label>
                  <select id="ed-sex" className="input" value={editing.patientSex}
                          onChange={(e) => setEditing({ ...editing, patientSex: e.target.value })}>
                    <option value="">—</option>
                    <option value="F">F</option>
                    <option value="M">M</option>
                  </select>
                </div>
              </div>

              <div className="stack" style={{ gap: 6 }}>
                <span className="label">Eye</span>
                <div className="seg">
                  {[["OD", "Right · OD"], ["OS", "Left · OS"]].map(([v, label]) => (
                    <button key={v} type="button" style={{ flex: 1, height: 40 }}
                            aria-pressed={editing.eyePosition === v}
                            onClick={() => setEditing({ ...editing, eyePosition: v })}>{label}</button>
                  ))}
                </div>
              </div>

              {detailsError && <div className="err">{detailsError}</div>}

              <div className="row" style={{ gap: 10 }}>
                <button className="btn grow" type="submit" disabled={savingDetails}>
                  {savingDetails ? "Saving…" : "Save details"}
                </button>
                <button className="btn btn-ghost" type="button" disabled={savingDetails}
                        onClick={() => { setEditing(null); setDetailsError(null); }}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="card stack" style={{ padding: "14px 16px", gap: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: "6px 10px", fontSize: 13.5 }}>
                <span className="muted">Patient</span><span className="mono">{c.patientCode}</span>
                <span className="muted">Born</span><span>{c.birthYear || "—"} · {c.patientSex || "—"}</span>
                <span className="muted">Eye</span><span>{c.eye === "OD" ? "Right · OD" : "Left · OS"}</span>
              </div>
              {c.updatedAt && (
                <div className="muted" style={{ fontSize: 11.5 }}>
                  Details corrected {when(c.updatedAt)}
                </div>
              )}
              <button type="button" className="linkish" style={{ alignSelf: "flex-start", fontSize: 12.5 }}
                      onClick={() => setEditing({
                        patientCode: c.patientCode ?? "",
                        birthYear: c.birthYear ?? "",
                        patientSex: c.patientSex ?? "",
                        eyePosition: c.eye,
                      })}>
                Correct these details
              </button>
            </div>
          )}

          <div className="card stack" style={{ padding: 16, gap: 14 }}>
            <div className="label">Model result</div>
            {c.grade == null ? (
              <div className="muted">
                {processing ? "The model is grading this image…"
                  : failed ? "No grade — the grading service could not be reached."
                  : "Not graded."}
              </div>
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

          {/* The review form appears only for a case the model has actually
              graded. Agreeing with a grade that does not exist is not a
              decision a doctor can make, so it must not be offered — the
              server refuses it (BR-2), but a button that always fails is a
              worse answer than no button. */}
          {processing ? (
            <div className="card stack" style={{ padding: 16, gap: 8 }}>
              <div className="label">Your assessment</div>
              <div style={{ fontWeight: 600 }}>Waiting for the model</div>
              <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                This case is being graded now. The review controls appear as soon
                as there is a grade to agree or disagree with.
              </div>
            </div>
          ) : failed ? (
            <div className="card stack" style={{ padding: 16, gap: 10 }}>
              <div className="label">Your assessment</div>
              <div style={{ fontWeight: 600, color: "var(--g4)" }}>Grading failed</div>
              <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                The grading service did not answer, so this image has no model
                grade. There is nothing to agree or disagree with yet — the
                photograph is saved and can be graded again once the service is
                back.
              </div>
              {formError && <div className="err">{formError}</div>}
              <button className="btn" onClick={regrade} disabled={regrading}>
                {regrading ? "Grading…" : "Try grading again"}
              </button>
            </div>
          ) : reviewed && !amending ? (
            <div className="card stack" style={{ padding: 16, gap: 10 }}>
              <div className="label">Your assessment</div>
              <div style={{ fontWeight: 600 }}>
                {c.agreement === "AGREE"
                  ? `Agreed — grade ${c.grade}`
                  : `Disagreed — corrected to ${c.correctedGrade} · ${GRADES[c.correctedGrade]}`}
              </div>
              {c.reason && <div className="muted" style={{ fontSize: 13.5 }}>{c.reason}</div>}

              {/* Amendments are kept, not overwritten. A doctor who mis-clicks
                  must be able to correct it; a record that silently changed
                  would defeat the point of storing the disagreement at all. */}
              {(c.reviews?.length ?? 0) > 1 && (
                <details style={{ fontSize: 12.5 }}>
                  <summary className="muted" style={{ cursor: "pointer" }}>
                    Amended {c.reviews.length - 1} time{c.reviews.length === 2 ? "" : "s"} — show history
                  </summary>
                  <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                    {c.reviews.map((r, i) => (
                      <div key={i} className="muted"
                           style={{ borderLeft: "2px solid var(--line-strong)", paddingLeft: 9 }}>
                        <div>
                          {r.agreement === "AGREE" ? "Agreed" : `Disagreed — grade ${r.correctedGrade}`}
                          {" · "}{when(r.at)}
                          {i === c.reviews.length - 1 && " · current"}
                        </div>
                        {r.reason && <div style={{ fontSize: 12 }}>{r.reason}</div>}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <button type="button" className="btn btn-ghost"
                      onClick={() => {
                        setAmending(true);
                        setAgreement(null);
                        setCorrected(c.correctedGrade ?? null);
                        setReason(c.reason ?? "");
                      }}>
                Change my assessment
              </button>
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

              <div className="row" style={{ gap: 10 }}>
                <button className="btn grow" disabled={!canSave || saving} onClick={save}>
                  {saving ? "Saving…" : amending ? "Save amendment" : "Save assessment"}
                </button>
                {amending && (
                  <button className="btn btn-ghost" type="button" disabled={saving}
                          onClick={() => { setAmending(false); setAgreement(null); setFormError(null); }}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}
          {/* Deleting is deliberately last, quiet, and two-step. A reviewed
              case is refused by the server, so the control says so rather than
              offering something that will fail. */}
          {reviewed ? (
            <div className="muted" style={{ fontSize: 11.5, textAlign: "center" }}>
              A reviewed case is a clinical record and is not deleted here.
            </div>
          ) : confirmDelete ? (
            <div className="card stack" style={{ padding: 14, gap: 10 }}>
              <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                Delete this case? The photograph
                {available.length ? ", its explanation maps" : ""} and the model's
                grade go with it. This cannot be undone.
              </div>
              {deleteError && <div className="err">{deleteError}</div>}
              <div className="row" style={{ gap: 10 }}>
                <button className="btn grow" onClick={removeCase} disabled={deleting}
                        style={{ background: "var(--danger)", borderColor: "var(--danger)" }}>
                  {deleting ? "Deleting…" : "Delete permanently"}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}
                        disabled={deleting}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="linkish"
                    style={{ alignSelf: "center", fontSize: 12.5, color: "var(--danger)" }}
                    onClick={() => setConfirmDelete(true)}>
              Delete this case
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
