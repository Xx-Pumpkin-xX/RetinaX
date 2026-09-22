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

/**
 * Filter one eye-row.
 *
 * Deliberately three narrow controls rather than one clever query language.
 * A doctor working a list wants "this patient", "what still needs me", and
 * "what is referable" — and referable is a real clinical threshold, not a
 * convenience: grade >= 2 (moderate NPDR) is the point at which screening
 * guidelines say send them to an ophthalmologist.
 */
function matches(c, { q, status, referableOnly }) {
  if (q) {
    const hay = `${c.patientCode} ${c.eye} ${c.birthYear ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (status === "AWAITING" && c.status !== "GRADED") return false;
  if (status === "REVIEWED" && c.status !== "REVIEWED") return false;
  if (status === "ATTENTION" && c.status !== "FAILED" && c.status !== "PROCESSING") return false;
  if (referableOnly) {
    // The doctor's correction is the grade that counts where one exists.
    const g = c.correctedGrade ?? c.grade;
    if (g == null || g < 2) return false;
  }
  return true;
}

/**
 * One row per eye, but the two eyes of a patient sit together.
 *
 * The grade is an eye-level fact, so the rows stay per eye. The referral
 * decision, though, is made per patient and follows the worse eye — so showing
 * OD and OS in separate places would leave the doctor doing that comparison
 * from memory.
 */
function groupByPatient(cases) {
  const groups = new Map();
  for (const c of cases) {
    if (!groups.has(c.patientCode)) groups.set(c.patientCode, []);
    groups.get(c.patientCode).push(c);
  }
  return [...groups.entries()]
    .map(([patientCode, rows]) => {
      rows.sort((a, b) => (a.eye === b.eye ? 0 : a.eye === "OD" ? -1 : 1));
      return {
        patientCode,
        rows,
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
  // Selection lives as ids, not rows: the worklist re-fetches every few
  // seconds, so anything holding row objects would be stale by the next tick.
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [regrading, setRegrading] = useState(null);   // null | {done, total}
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
        // Seeding a new account happens in the background, and an upload sits
        // in PROCESSING while the model runs. Without this the first thing a
        // new user sees is one row saying "Grading…" that never changes until
        // they think to refresh.
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

  // Paged by PATIENT, not by row, and a patient is never split across a
  // page boundary: the whole point of grouping the two eyes is that the
  // referral decision compares them, and comparing across a page turn is
  // comparing from memory. So a page holds whole patients up to roughly
  // PAGE_ROWS rows, which lands on 10 for the usual two-eyes-per-patient list.
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

  // Narrowing the list while sitting on page 4 would show an empty table and
  // look like the filter deleted everything.
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

  /**
   * Re-grade the ticked cases whose grading failed.
   *
   * ONE AT A TIME, deliberately. Every re-grade is a full pass on the GPU that
   * the model service also needs for live uploads; firing five at once does
   * not make them finish sooner, it makes all five slow enough to time out and
   * takes the service down with them. Sequential also means the counter is
   * true - "3 of 5" is a fact, not an estimate.
   *
   * The API refuses to re-grade anything that is not FAILED, so only those are
   * sent. Nothing here can overwrite a grade a doctor has already seen.
   */
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

  /**
   * Delete whatever is ticked.
   *
   * This replaced two separate controls: a "remove every failed case" button
   * that decided for you which cases were litter, and a per-row Remove that
   * could only ever take one. Ticking says exactly what goes, and the same
   * dialog covers one case and twelve.
   *
   * One request per case rather than a bulk endpoint: each deletion is then
   * authorised and logged individually, and a failure part-way through leaves
   * the rest deleted rather than rolling back work the doctor asked for.
   */
  async function deleteSelected() {
    setConfirmDelete(false);
    setDeleting(true);
    setClearError(null);

    const results = await Promise.allSettled(
      // A reviewed case needs the second, explicit signal the API asks for.
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

      {/* The dialog names every case it is about to remove. "12 selected" is a
          number, and a number is not something you can check. A reviewed case
          among them is called out separately, because that is the one where
          something irreplaceable goes. */}
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
                  <tr key={c.id} onClick={() => navigate(`/cases/${c.id}`)}
                      style={i === 0 && p !== shown[0] ? { borderTop: "2px solid var(--line-strong)" } : undefined}>
                    <td className="mono">
                      {i === 0 ? (
                        <span>{p.patientCode}</span>
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
                    {/* stopPropagation on the cell, not just the input: the
                        whole row navigates, and a click that lands on the
                        padding beside the box would open the case instead of
                        ticking it. */}
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
