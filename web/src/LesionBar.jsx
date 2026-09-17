/**
 * The six lesion classes, as a row of chips.
 *
 * THREE STATES, NOT TWO
 *
 * A chip says one of three things, and the third one is the reason this
 * component exists:
 *
 *   found         a model ran and marked N areas. Clickable: it draws them.
 *   none          a model ran and marked nothing. A real, measured zero.
 *   not_assessed  no model ran, or its recall is not good enough to be
 *                 believed. NO CLAIM IS MADE EITHER WAY.
 *
 * Collapsing the third into the second is the failure mode worth guarding
 * against. "We did not look for neovascularisation" and "this eye has no
 * neovascularisation" are opposite statements, and NV is the finding that
 * decides whether someone is referred urgently. A screen that shows a
 * confident zero for a class the model cannot actually detect is worse than a
 * screen that shows nothing at all, because it is trusted.
 *
 * WHY ONE CLASS DRAWS AT A TIME
 *
 * Six sets of coloured contours over a textured red photograph is not six
 * times the information; it is a mess that hides the retina. Identity comes
 * from which chip is lit, so the marks need only one colour and stay readable.
 */

export const LESIONS = [
  { key: "MA", name: "Microaneurysms" },
  { key: "HE", name: "Haemorrhages" },
  { key: "EX", name: "Hard exudates" },
  { key: "SE", name: "Soft exudates" },
  { key: "IRMA", name: "IRMA" },
  { key: "NV", name: "Neovascularisation" },
];

const WHY = {
  grade_0:
    "No retinopathy was graded, so the lesion models were not run. This is not a finding that the eye is free of them.",
  recall_not_credible:
    "This class has not been shown to be detected reliably, so the screen makes no claim either way.",
  no_model: "No model has been trained for this class yet.",
};

export default function LesionBar({ lesions, active, onPick }) {
  const byKey = new Map((lesions?.classes || []).map((l) => [l.key, l]));

  return (
    <div className="stack" style={{ gap: 8, padding: "0 16px 14px" }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {LESIONS.map(({ key, name }) => {
          const l = byKey.get(key);
          const state = l?.state ?? "not_assessed";
          const why = l?.why ?? lesions?.reason ?? "no_model";
          const on = active === key;
          const clickable = state === "found";

          const title =
            state === "found"
              ? `${name} — ${l.count} area${l.count === 1 ? "" : "s"} marked. Click to show them.`
              : state === "none"
                ? `${name} — the model ran on this image and marked none.`
                : `${name} — not assessed. ${WHY[why] ?? ""}`;

          return (
            <button
              key={key}
              type="button"
              className={`lesion-chip ${state}${on ? " on" : ""}`}
              disabled={!clickable}
              aria-pressed={clickable ? on : undefined}
              title={title}
              onClick={() => clickable && onPick(on ? null : key)}
            >
              <span className="lesion-key">{key}</span>
              <span className="lesion-count">
                {state === "found" ? l.count : state === "none" ? "0" : "—"}
              </span>
            </button>
          );
        })}
      </div>

      {/* The legend is not decoration. Without it a dash and a zero look like
          the same answer, and they are not. */}
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.55 }}>
        <strong>n</strong> areas marked · <strong>0</strong> looked for, none found ·{" "}
        <strong>—</strong> not assessed, no claim made
      </div>
    </div>
  );
}
