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
  const patients = cases ? groupByPatient(cases) : [];

  return (
    <div className="page stack" style={{ gap: 18 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 2 }}>
          <h1 style={{ fontSize: 23, fontWeight: 600, margin: 0 }}>My cases</h1>
          <div className="muted" style={{ fontSize: 13.5 }}>
            {cases
              ? `${patients.length} patient${patients.length === 1 ? "" : "s"} · ${waiting} awaiting your review`
              : "Loading…"}
          </div>
        </div>
        <Link to="/cases/new"><button className="btn">+ New case</button></Link>
      </div>

      {error && <div className="err">{error}</div>}

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
              <tr><th>Patient</th><th>Eye</th><th>Captured</th><th>AI grade</th><th>Status</th></tr>
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
        otherwise the model's.
      </div>
    </div>
  );
}
