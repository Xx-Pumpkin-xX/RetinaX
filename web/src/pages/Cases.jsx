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
      const graded = rows.filter((r) => r.grade != null);
      return {
        patientCode,
        rows,
        // The doctor's corrected grade is the one that counts where it exists.
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
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
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

  const clear = () => { setQ(""); setStatus("ALL"); setReferableOnly(false); };

  const failed = cases?.filter((c) => c.status === "FAILED") ?? [];

  /**
   * Delete every failed case at once.
   *
   * One request per case rather than a bulk endpoint: each deletion is then
   * authorised and logged individually, and a failure part-way through leaves
   * the rest deleted rather than rolling back work the doctor asked for. There
   * are never many — a handful of failed uploads, not thousands.
   */
  async function clearFailed() {
    setClearing(true);
    setClearError(null);
    const results = await Promise.allSettled(failed.map((c) => api.deleteCase(c.id)));
    const stuck = results.filter((r) => r.status === "rejected").length;
    if (stuck) setClearError(`${stuck} of ${failed.length} could not be removed.`);
    try {
      setCases(await api.cases());
    } catch (e) {
      setError(e.message);
    }
    setClearing(false);
  }

  async function removeCase(c) {
    if (!window.confirm("Delete this case? This cannot be undone.")) {
      return;
    }

    setDeletingId(c.id);
    setClearError(null);
    try {
      await api.deleteCase(c.id);
      setCases((current) => current?.filter((item) => item.id !== c.id) ?? current);
    } catch (e) {
      setClearError(e.message);
    } finally {
      setDeletingId(null);
    }
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

          {/* A failed case holds no grade, no explanation and no assessment —
              it is litter, and litter in a worklist costs attention. */}
          {failed.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={clearFailed}
                    disabled={clearing} title="Deletes every case whose grading failed"
                    style={{ height: 38, padding: "0 12px", fontSize: 13, color: "var(--danger)" }}>
              {clearing
                ? "Removing…"
                : `Remove ${failed.length} failed`}
            </button>
          )}
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
              <tr><th>Patient</th><th>Eye</th><th>Captured</th><th>AI grade</th><th>Status</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {patients.map((p) =>
                p.rows.map((c, i) => (
                  <tr key={c.id} onClick={() => navigate(`/cases/${c.id}`)}
                      style={i === 0 && p !== patients[0] ? { borderTop: "2px solid var(--line-strong)" } : undefined}>
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
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="linkish"
                        style={{ color: "var(--danger)", fontSize: 12.5 }}
                        disabled={deletingId === c.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeCase(c);
                        }}
                      >
                        {deletingId === c.id ? "Removing…" : "Remove"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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
