import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";

// Jump to the same patient's other eye without going back to My cases.
export default function NextEyeButton({ dirty = false }) {
  const { id } = useParams();
  const [other, setOther] = useState(null);

  useEffect(() => {
    let alive = true;
    api.cases()
      .then((rows) => {
        if (!alive) return;
        const here = rows.find((r) => r.id === id);
        if (!here) return;
        // Newest first, so a re-upload wins over an older attempt at that eye.
        const match = rows
          .filter((r) => r.patientCode === here.patientCode && r.eye !== here.eye)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        setOther(match ?? null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [id]);

  if (!other) return null;

  function confirmLeave(e) {
    if (dirty && !window.confirm(
      "You have unsaved changes. Leaving this page will discard them. Continue?")) {
      e.preventDefault();
    }
  }

  return (
    <Link to={`/cases/${other.id}`} onClick={confirmLeave}>
      <button
        className="btn btn-ghost"
        style={{ height: 36, padding: "0 14px", fontSize: 13, background: "var(--surface)" }}
      >
        Next eye: {other.eye === "OD" ? "Right (OD)" : "Left (OS)"} →
      </button>
    </Link>
  );
}