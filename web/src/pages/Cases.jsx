import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, GRADES, gradeVar } from "../api.js";

const when = (iso) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function StatusCell({ c }) {
  if (c.status === "PROCESSING") return <span className="muted">Grading…</span>;
  if (c.status === "FAILED") return <span style={{ color: "var(--g4)" }}>Grading failed</span>;
  if (c.status === "GRADED") return <span className="pill pill-live">Awaiting review</span>;
  return (
    <span className="muted">
      Reviewed · {c.agreement === "AGREE" ? "agreed" : `corrected to ${c.correctedGrade}`}
    </span>
  );
}

function matches(c, { q, status, referableOnly }) {
  if (q) {
    const hay = `${c.patientCode} ${c.eye} ${c.birthYear ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (status === "AWAITING" && c.status !== "GRADED") return false;
  if (status === "REVIEWED" && c.status !== "REVIEWED") return false;
  if (status === "ATTENTION" && c.status !== "FAILED" && c.status !== "PROCESSING") return false;
  if (referableOnly) {
    const g = c.correctedGrade ?? c.grade;
    if (g == null || g < 2) return false;
  }
  return true;
}

function groupByPatient(cases) {
  const groups = new Map();
  for (const c of cases) {
    if (!groups.has(c.patientCode)) groups.set(c.patientCode, []);
    groups.get(c.patientCode).push(c);
  }
  return [...groups.entries()]
    .map(([patientCode, rows]) => {
      rows.sort((a, b) => (a.eye === b.eye ? 0 : a.eye === "OD" ? -1 : 1));
      const graded = rows.filter((r) => r.grade != null);
      return {
        patientCode,
        rows,
        worst: graded.length
          ? Math.max(...graded.map((r) => (r.correctedGrade ?? r.grade)))
          : null,
        latest: Math.max(...rows.map((r) => new Date(r.createdAt).getTime())),
        pending: rows.filter((r) => r.status === "GRADED").length,
      };
    })
    .sort((a, b) => b.latest - a.latest);
}

export default function Cases() {
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [referableOnly, setReferableOnly] = useState(false);
  const [clearError, setClearError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [regrading, setRegrading] = useState(null);
  const [page, setPage] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    let timer;

    async function load() {
      try {
        const rows = await api.cases();
        if (!alive) return;
        setCases(rows);
        if (rows.some((c) => c.status === "PROCESSING")) {
          timer = setTimeout(load, 2000);
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    }

    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const waiting = cases?.filter((c) => c.status === "GRADED").length ?? 0;
  const filters = { q: q.trim().toLowerCase(), status, referableOnly };
  const filtering = Boolean(filters.q) || status !== "ALL" || referableOnly;
  const visible = cases ? cases.filter((c) => matches(c, filters)) : [];
  const patients = cases ? groupByPatient(visible) : [];
  const allPatients = cases ? groupByPatient(cases).length : 0;

  const PAGE_ROWS = 10;

  const pages = [];
  {
    let bucket = [];
    let rows = 0;
    for (const p of patients) {
      if (rows > 0 && rows + p.rows.length > PAGE_ROWS) {
        pages.push(bucket);
        bucket = [];
        rows = 0;
      }
      bucket.push(p);
      rows += p.rows.length;
    }
    if (bucket.length) pages.push(bucket);
  }
  const pageIndex = Math.min(page, Math.max(0, pages.length - 1));
  const shown = pages[pageIndex] ?? [];

  const clear = () => { setQ(""); setStatus("ALL"); setReferableOnly(false); };

  useEffect(() => { setPage(0); }, [q, status, referableOnly]);

  const chosen = cases?.filter((c) => selected.has(c.id)) ?? [];
  const chosenReviewed = chosen.filter((c) => c.status === "REVIEWED");
  const chosenFailed = chosen.filter((c) => c.status === "FAILED");

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function regradeSelected() {
    setClearError(null);
    setRegrading({ done: 0, total: chosenFailed.length });

    let stuck = 0;
    for (let i = 0; i < chosenFailed.length; i++) {
      try {
        await api.regrade(chosenFailed[i].id);
      } catch {
        stuck++;
      }
      setRegrading({ done: i + 1, total: chosenFailed.length });
    }
    if (stuck) setClearError(`${stuck} of ${chosenFailed.length} could not be re-graded.`);

    setSelected(new Set());
    try {
      setCases(await api.cases());
    } catch (e) {
      setError(e.message);
    }
    setRegrading(null);
  }

  async function deleteSelected() {
    setConfirmDelete(false);
    setDeleting(true);
    setClearError(null);

    const results = await Promise.allSettled(
      chosen.map((c) =>
        api.deleteCase(c.id, c.status === "REVIEWED" ? "DELETE-REVIEWED" : undefined))
    );
    const stuck = results.filter((r) => r.status === "rejected").length;
    if (stuck) setClearError(`${stuck} of ${chosen.length} could not be removed.`);

    setSelected(new Set());
    try {
      setCases(await api.cases());
    } catch (e) {
      setError(e.message);
    }
    setDeleting(false);
  }

  return (
    <div className="page stack" style={{ gap: 18 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 2 }}>
          <h1 style={{ fontSize: 23, fontWeight: 600, margin: 0 }}>My cases</h1>
          <div className="muted" style={{ fontSize: 13.5 }}>
            {!cases ? "Loading…"
              : filtering
                ? `${patients.length} of ${allPatients} patient${allPatients === 1 ? "" : "s"} shown`
                : `${allPatients} patient${allPatients === 1 ? "" : "s"} · ${waiting} awaiting your review`}
          </div>
        </div>
        <Link to="/cases/new"><button className="btn">+ New case</button></Link>
      </div>

      {error && <div className="err">{error}</div>}
      {clearError && <div className="err">{clearError}</div>}

      {cases && cases.length > 0 && (
        <div className="card row" style={{ padding: 12, gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div className="row grow" style={{ gap: 8, minWidth: 240, position: "relative" }}>
            <label className="label" htmlFor="case-search" style={{ position: "absolute", left: -9999 }}>
              Search cases
            </label>
            <input
              id="case-search"
              className="input grow"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search patient code, eye, year of birth…"
              autoComplete="off"
            />
          </div>

          <div className="seg" role="group" aria-label="Filter by status">
            {[["ALL", "All"], ["AWAITING", "Awaiting review"], ["REVIEWED", "Reviewed"], ["ATTENTION", "Needs attention"]]
              .map(([v, label]) => (
                <button key={v} type="button" aria-pressed={status === v}
                        onClick={() => setStatus(v)} style={{ height: 38, padding: "0 12px" }}>
                  {label}
                </button>
              ))}
          </div>

          <label className="row" style={{ gap: 8, fontSize: 13.5, cursor: "pointer", whiteSpace: "nowrap" }}
                 title="Grade 2 and above — the threshold at which screening guidelines refer a patient on">
            <input type="checkbox" checked={referableOnly}
                   onChange={(e) => setReferableOnly(e.target.checked)} />
            Referable only
          </label>

          {filtering && (
            <button type="button" className="btn btn-ghost" onClick={clear}
                    style={{ height: 38, padding: "0 12px", fontSize: 13 }}>
              Clear
            </button>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="card row" style={{ padding: "10px 14px", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 13.5 }}>
            <strong>{selected.size}</strong> selected
          </span>
          <button type="button" className="btn btn-ghost"
                  onClick={() => setSelected(new Set())} disabled={deleting}
                  style={{ height: 34, padding: "0 12px", fontSize: 13 }}>
            Clear selection
          </button>
          <span className="grow" />

          {chosenFailed.length > 0 && (
            <button type="button" className="btn btn-ghost"
                    disabled={deleting || Boolean(regrading)}
                    onClick={regradeSelected}
                    title="Runs the model again on the cases whose grading failed. Minutes, not seconds."
                    style={{ height: 34, padding: "0 14px", fontSize: 13 }}>
              {regrading
                ? `Re-grading ${regrading.done} of ${regrading.total}…`
                : `Re-grade ${chosenFailed.length} failed`}
            </button>
          )}

          <button type="button" className="btn" disabled={deleting || Boolean(regrading)}
                  onClick={() => { setClearError(null); setConfirmDelete(true); }}
                  style={{ height: 34, padding: "0 14px", fontSize: 13,
                           background: "var(--danger)", borderColor: "var(--danger)" }}>
            {deleting ? "Removing…" : `Delete ${selected.size}`}
          </button>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="del-many"
             onMouseDown={(e) => { if (e.target === e.currentTarget && !deleting) setConfirmDelete(false); }}>
          <div className="modal stack" style={{ gap: 12 }}>
            <h3 id="del-many" className="modal-title">
              Delete {chosen.length} case{chosen.length === 1 ? "" : "s"}?
            </h3>
            <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              The photograph{chosen.length === 1 ? "" : "s"} and the model's
              grade{chosen.length === 1 ? "" : "s"} go with
              {chosen.length === 1 ? " it" : " them"}. This cannot be undone.
            </div>

            {chosenReviewed.length > 0 && (
              <div className="modal-losing">
                {chosenReviewed.length} of these {chosenReviewed.length === 1 ? "is" : "are"} already
                reviewed. Deleting {chosenReviewed.length === 1 ? "it" : "them"} also removes the
                recorded assessment and every earlier amendment of it.
              </div>
            )}

            <div className="card stack" style={{ padding: 10, gap: 4, maxHeight: 220, overflowY: "auto" }}>
              {chosen.map((c) => (
                <div key={c.id} className="row mono" style={{ fontSize: 12.5, gap: 8 }}>
                  <span>{c.patientCode} · {c.eye}</span>
                  <span className="grow" />
                  <span className="muted">
                    {c.status === "REVIEWED" ? "reviewed" :
                     c.status === "FAILED" ? "grading failed" :
                     c.grade == null ? "no grade" : `grade ${c.grade}`}
                  </span>
                </div>
              ))}
            </div>

            <div className="row" style={{ gap: 10 }}>
              <button className="btn grow" onClick={deleteSelected} disabled={deleting}
                      style={{ background: "var(--danger)", borderColor: "var(--danger)" }}>
                {deleting ? "Removing…" : "Delete permanently"}
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}
                      disabled={deleting}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {cases && cases.length > 0 && patients.length === 0 && (
        <div className="card stack" style={{ padding: 36, alignItems: "center", gap: 8 }}>
          <div style={{ fontWeight: 600 }}>Nothing matches</div>
          <div className="muted" style={{ fontSize: 13.5 }}>
            {allPatients} patient{allPatients === 1 ? "" : "s"} in your worklist, none matching these filters.
          </div>
          <button type="button" className="btn btn-ghost" onClick={clear} style={{ marginTop: 4 }}>
            Clear filters
          </button>
        </div>
      )}

      {cases && cases.length === 0 && (
        <div className="card stack" style={{ padding: 40, alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 600 }}>No cases yet</div>
          <div className="muted" style={{ fontSize: 13.5, textAlign: "center", maxWidth: 380, lineHeight: 1.55 }}>
            A new account starts empty — you only ever see cases you uploaded
            yourself. Add a fundus photograph and the model will grade it.
          </div>
          <Link to="/cases/new" style={{ marginTop: 4 }}>
            <button className="btn">+ New case</button>
          </Link>
        </div>
      )}

      {patients.length > 0 && (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr><th>Patient</th><th>Eye</th><th>Captured</th><th>AI grade</th><th>Status</th><th aria-label="Select" /></tr>
            </thead>
            <tbody>
              {shown.map((p) =>
                p.rows.map((c, i) => (
                  <tr key={c.id} onClick={() => navigate(`/cases/${c.id}`, {
                        // Lets the doctor step to the other eye of this
                        // patient from the result page instead of having to
                        // come back here first — same "Next eye's result"
                        // control that already runs right after an upload.
                        state: { resultQueue: p.rows.map((r) => r.id), resultStep: i },
                      })}
                      style={i === 0 && p !== shown[0] ? { borderTop: "2px solid var(--line-strong)" } : undefined}>
                    <td className="mono">
                      {i === 0 ? (
                        <span className="row" style={{ gap: 9 }}>
                          {p.patientCode}
                          {p.rows.length > 1 && p.worst != null && (
                            <span className="muted" style={{ fontSize: 11.5 }}>
                              worse eye {p.worst}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>↳ same patient</span>
                      )}
                    </td>
                    <td>{c.eye}</td>
                    <td className="muted">{when(c.createdAt)}</td>
                    <td>
                      {c.grade == null ? <span className="muted">—</span> : (
                        <span className="row" style={{ gap: 9 }}>
                          <span className="dot" style={{ background: gradeVar(c.grade) }} />
                          {c.grade} · {GRADES[c.grade]}
                        </span>
                      )}
                    </td>
                    <td><StatusCell c={c} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}
                        onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="pick"
                        checked={selected.has(c.id)}
                        disabled={deleting}
                        onChange={() => toggle(c.id)}
                        aria-label={`Select ${c.patientCode} ${c.eye}`}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {pages.length > 1 && (
        <div className="row" style={{ gap: 10, alignItems: "center", justifyContent: "center" }}>
          <button type="button" className="btn btn-ghost" disabled={pageIndex === 0}
                  onClick={() => setPage(pageIndex - 1)}
                  style={{ height: 34, padding: "0 12px", fontSize: 13 }}>
            ← Previous
          </button>
          <span className="muted mono" style={{ fontSize: 12.5 }}>
            {pageIndex + 1} / {pages.length}
          </span>
          <button type="button" className="btn btn-ghost" disabled={pageIndex >= pages.length - 1}
                  onClick={() => setPage(pageIndex + 1)}
                  style={{ height: 34, padding: "0 12px", fontSize: 13 }}>
            Next →
          </button>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        You only see cases you uploaded. Each row is one eye; a patient's two eyes are grouped.
        "Worse eye" is the higher of the two grades — the doctor's correction where one exists,
        otherwise the model's. "Referable" means grade 2 or above, the threshold at which
        screening guidelines send a patient on to an ophthalmologist.
      </div>
    </div>
  );
}