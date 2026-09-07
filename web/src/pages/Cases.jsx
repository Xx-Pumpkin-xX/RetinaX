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

export default function Cases() {
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.cases().then(setCases).catch((e) => setError(e.message));
  }, []);

  const waiting = cases?.filter((c) => c.status === "GRADED").length ?? 0;

  return (
    <div className="page stack" style={{ gap: 18 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 2 }}>
          <h1 style={{ fontSize: 23, fontWeight: 600, margin: 0 }}>My cases</h1>
          <div className="muted" style={{ fontSize: 13.5 }}>
            {cases ? `${waiting} awaiting your review` : "Loading…"}
          </div>
        </div>
        <Link to="/cases/new"><button className="btn">+ New case</button></Link>
      </div>

      {error && <div className="err">{error}</div>}

      {cases && cases.length === 0 && (
        <div className="card stack" style={{ padding: 40, alignItems: "center", gap: 8 }}>
          <div style={{ fontWeight: 600 }}>No cases yet</div>
          <div className="muted" style={{ fontSize: 13.5 }}>Upload a fundus photograph to get started.</div>
        </div>
      )}

      {cases && cases.length > 0 && (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr><th>Patient</th><th>Eye</th><th>Captured</th><th>AI grade</th><th>Status</th></tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} onClick={() => navigate(`/cases/${c.id}`)}>
                  <td className="mono">{c.patientCode}</td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        You only see cases you uploaded. Each row is one eye.
      </div>
    </div>
  );
}
