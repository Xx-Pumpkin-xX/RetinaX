import { useEffect, useState } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { api, GRADES, gradeVar } from "../api.js";
import ApiImage from "../ApiImage.jsx";
import RegionOverlay from "../RegionOverlay.jsx";
import LesionBar, { LESIONS } from "../LesionBar.jsx";
import NextEyeButton from "./NextEyeButton.jsx";

const when = (iso) =>
  new Date(iso).toLocaleString("en-GB",
    { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const METHODS = [
  { key: "cam", label: "Grad-CAM" },
];

const SUPPRESSED = {
  grade_0: "No retinopathy was found, so there is nothing for an explanation to point at. A map drawn here would mark noise.",
  outside_fov: "Most of the model's attention fell outside the retina — on the crop edge or the black border — so the map describes the photograph, not the eye. It has not been shown.",
  no_map: "The service returned no explanation map for this image.",
};

// Remount per case. Going from one eye to the other keeps the same route
// component alive, so without a key the previous eye's half-made assessment,
// edit form, amend mode and delete dialog would carry over to the new eye and
// could be saved against a photograph the doctor has not looked at yet.
export default function CaseDetail() {
  const { id } = useParams();
  return <CaseDetailInner key={id} />;
}

function CaseDetailInner() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [c, setCase] = useState(null);
  const [error, setError] = useState(null);

  const [overlay, setOverlay] = useState("Default");
  const [opacity, setOpacity] = useState(0.62);

  const [agreement, setAgreement] = useState(null);
  const [corrected, setCorrected] = useState(null);
  const [reason, setReason] = useState("");

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [regrading, setRegrading] = useState(false);
  const [amending, setAmending] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [editing, setEditing] = useState(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [explainError, setExplainError] = useState(null);

  const resultQueue = location.state?.resultQueue ?? null;
  const resultStep = location.state?.resultStep ?? 0;
  const hasNextResult = resultQueue && resultStep < resultQueue.length - 1;
  const nextResultId = hasNextResult ? resultQueue[resultStep + 1] : null;

  const dirty = editing !== null || agreement !== null;

  useEffect(() => {
    function handleBeforeUnload(e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e) => { if (e.key === "Escape" && !deleting) setConfirmDelete(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete, deleting]);

  useEffect(() => {
    let alive = true;
    let timer;

    function load() {
      api.case(id)
        .then((row) => {
          if (!alive) return;
          setCase(row);
          const has = row.overlays || [];
          setOverlay(
            row.regions?.length ? "regions"
              : has.includes("cam") ? "cam"
              : "Default"
          );
          if (row.status === "PROCESSING") timer = setTimeout(load, 2000);
        })
        .catch((e) => alive && setError(e.message));
    }

    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [id]);

  function goToCases(e) {
    if (!dirty) return;
    e.preventDefault();
    if (window.confirm("You have unsaved changes. Leaving this page will discard them. Continue?")) {
      navigate("/cases");
    }
  }

  async function removeCase() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteCase(id, c?.status === "REVIEWED" ? "DELETE-REVIEWED" : undefined);
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
    setExplaining("cam");
    setExplainError(null);
    try {
      const updated = await api.explain(id, { ccem: false });
      setCase(updated);
      setOverlay("cam");
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
      setCase(await api.case(id));
    } finally {
      setRegrading(false);
    }
  }

  async function save() {
    setSaving(true);
    setFormError(null);

    try {
      const updated = await api.mark(id, {
        agreement,
        correctedGrade: corrected,
        reason,
      });

      setCase(updated);

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

  const activeLesion = overlay.startsWith("lesion:") ? overlay.slice(7) : null;
  const lesionShown = (c.lesions?.classes || []).find((l) => l.key === activeLesion);
  const lesionName = LESIONS.find((l) => l.key === activeLesion)?.name ?? activeLesion;
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
          <Link to="/cases" className="muted" style={{ fontSize: 16, color: "var(--accent)", fontWeight: 600 }} onClick={goToCases}>← My cases</Link>
          <div className="row" style={{ gap: 12, alignItems: "baseline" }}>
            <span className="mono" style={{ fontSize: 22, fontWeight: 500 }}>{c.patientCode}</span>
            <span className="muted">{c.eye === "OD" ? "Right eye · OD" : "Left eye · OS"}</span>
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          {/* Hidden while the "Result x of y" card below is showing, so there
              are never two next-eye buttons on screen at once. */}
          {!hasNextResult && <NextEyeButton dirty={dirty} />}
          <span className={graded ? "pill pill-live" : "pill"}
                style={failed ? { color: "var(--g4)", borderColor: "var(--g4)" } : undefined}>
            {reviewed ? "Reviewed"
              : graded ? "Awaiting your review"
              : processing ? "Grading…"
              : "Grading failed"}
          </span>
        </div>
      </div>

      {hasNextResult && (
        <div className="card row" style={{ padding: 12, gap: 12, justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13.5 }}>
            Result {resultStep + 1} of {resultQueue.length} for this patient.
          </span>
          <button className="btn btn-ghost" type="button"
                  onClick={() => navigate(`/cases/${nextResultId}`, {
                    state: { resultQueue, resultStep: resultStep + 1 },
                  })}>
            Next eye's result →
          </button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 18, alignItems: "start" }}>

        <div className="card stack" style={{ overflow: "hidden" }}>
          <div className="viewer" style={{ height: 560 }}>
            <ApiImage path={`/api/cases/${c.id}/image`} alt="Fundus photograph" />
            {overlay === "regions" && (
              <RegionOverlay regions={regions} size={c.imageSize} />
            )}
            {lesionShown && (
              <RegionOverlay tone="lesion" size={c.imageSize}
                             label={`${lesionShown.count} ${lesionName} marked`}
                             regions={(lesionShown.polygons || []).map((p, i) => ({ polygon: p, rank: i + 1 }))} />
            )}
            {overlay !== "Default" && overlay !== "regions" && !activeLesion && (
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
                   disabled={overlay === "Default" || overlay === "regions" || !!activeLesion}
                   aria-label="Overlay opacity" />
            <span className="mono muted" style={{ fontSize: 12.5, width: 40 }}>
              {Math.round(opacity * 100)}%
            </span>
          </div>
          <LesionBar lesions={c.lesions} active={activeLesion}
                     onPick={(k) => setOverlay(k ? `lesion:${k}` : "Default")} />

          {lesionShown && (
            <>
              <div style={{ borderTop: "1px solid var(--line)", margin: "0 16px" }} />
              <div className="muted" style={{ fontSize: 12.5, padding: "12px 16px", lineHeight: 1.5 }}>
                {lesionShown.count} area{lesionShown.count === 1 ? "" : "s"} marked as{" "}
                <strong>{lesionName}</strong> by a lesion model, which is a different model from the
                one that produced grade {c.grade}. The two can disagree; neither overrules your reading.
                {lesionShown.reliability && lesionShown.reliability !== "established" && (
                  <>
                    {" "}This class is <strong>experimental</strong>
                    {lesionShown.recall != null && (
                      <> — in validation it found {Math.round(lesionShown.recall * 100)}% of them,
                        measured on {lesionShown.gt_lesions} lesions</>
                    )}. Treat these marks as hints, not findings.
                  </>
                )}
              </div>
            </>
          )}

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
                Grad-CAM explanation overlay. Redrawing re-renders the overlay from the current model without changing the grade.
              </div>
              {explainError && <div className="err">{explainError}</div>}
              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <button className="btn btn-ghost" onClick={redraw} disabled={Boolean(explaining)} title="Re-runs Grad-CAM and redraws the overlay. The grade is not recomputed.">
                  {explaining ? "Redrawing…" : "Redraw overlay"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 14 }}>
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
                  <button
                    key={v}
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setAgreement(v);
                      setReason("");
                      if (v === "AGREE") {
                        setCorrected(null);
                      }
                    }}
                    style={{
                      height: 58,
                      borderWidth: agreement === v ? 2 : 1,
                      borderColor: agreement === v ? `var(${tone})` : "var(--line-strong)",
                      background: agreement === v ? `color-mix(in srgb, var(${tone}) 12%, transparent)` : "transparent",
                      fontWeight: agreement === v ? 600 : 500,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {agreement === "AGREE" && (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13 }}>Note</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>Optional</span>
                  </div>
                  <textarea
                    className="input"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Add an observation about the prediction or highlighted regions…"
                  />
                </div>
              )}

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

          <button type="button" className="linkish"
                  style={{ alignSelf: "center", fontSize: 16, fontWeight: 600, color: "var(--danger)" }}
                  onClick={() => { setConfirmText(""); setDeleteError(null); setConfirmDelete(true); }}>
            Delete this case
          </button>

          {confirmDelete && (
            <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="del-title"
                 onMouseDown={(e) => { if (e.target === e.currentTarget && !deleting) setConfirmDelete(false); }}>
              <div className="modal stack" style={{ gap: 12 }}>
                <h3 id="del-title" className="modal-title">Delete this case?</h3>
                <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                  The photograph{available.length ? ", its explanation maps" : ""} and the
                  model's grade go with it. This cannot be undone.
                </div>

                {reviewed && (
                  <>
                    <div className="modal-losing">
                      This case has a recorded assessment. Deleting it also removes:
                      <div>· the model's grade — {c.gradeLabel ?? "—"}</div>
                      <div>
                        · your assessment — {c.agreement ?? "—"}
                        {c.correctedGrade != null && ` (corrected to ${c.correctedGrade})`}
                      </div>
                      <div>· every earlier amendment of it</div>
                    </div>
                    <label className="label" htmlFor="del-code">
                      Confirm by typing the patient code
                    </label>
                    <div className="mono" style={{ fontSize: 13.5, marginTop: -6 }}>{c.patientCode}</div>
                    <input id="del-code" className="input mono" autoComplete="off" autoFocus
                           value={confirmText} disabled={deleting}
                           onChange={(e) => setConfirmText(e.target.value)} />
                  </>
                )}

                {deleteError && <div className="err">{deleteError}</div>}

                <div className="row" style={{ gap: 10 }}>
                  <button className="btn grow" onClick={removeCase}
                          disabled={deleting || (reviewed && confirmText.trim() !== c.patientCode)}
                          style={{ background: "var(--danger)", borderColor: "var(--danger)" }}>
                    {deleting ? "Deleting…" : "Delete permanently"}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}
                          disabled={deleting}>Cancel</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}