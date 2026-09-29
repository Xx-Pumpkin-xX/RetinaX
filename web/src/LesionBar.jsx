/**
 * The six lesion classes, as a row of chips.
 *
 * ALL SIX ARE HERE. THEY DO NOT ALL CARRY THE SAME WEIGHT.
 *
 * A chip says one of three things:
 *
 *   found         a model marked n areas. Clickable: it draws them.
 *   none          a model ran, marked nothing, and is trusted to mean it.
 *   not_assessed  no model, or a model whose silence proves nothing.
 *
 * And separately, `reliability` says how far to trust it: `established` for a
 * class measured above the recall bar on a large enough sample, `provisional`
 * for one that is not.
 *
 * WHY POSITIVE AND NEGATIVE ARE TREATED DIFFERENTLY
 *
 * A provisional class may still point at something - that is a suggestion the
 * clinician looks at and dismisses in a second, and hiding it would throw away
 * information for no gain. What a provisional class may never do is report an
 * absence, because an absence cannot be checked by looking. Neovascularisation
 * decides urgent referral, and a model that finds one in four is wrong three
 * times out of four when it stays silent.
 *
 * So: provisional classes may point, never reassure. The chip marks them with
 * a "~" on the count and says the measured recall on hover, so the difference
 * survives being screenshotted into a slide.
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
  no_model: "No model has been trained for this class yet.",
  low_recall:
    "The model marked nothing, but it has not been shown to find this class reliably, so its silence is not evidence of absence.",
  unmeasured:
    "This model has not been measured on held-out data, so no claim is made either way.",
};

const pct = (v) => (v == null ? null : `${Math.round(v * 100)}%`);

// The legend's glyph column. Fixed width so the lines read as a table.
const SYM = { display: "inline-block", width: 30 };

// An acronym stays an acronym: "20% of irma" reads like a typo.
const inSentence = (s) => (s === s.toUpperCase() ? s : s.toLowerCase());

function measured(l, name) {
  if (l?.recall == null) return "";
  const sample = l.gt_lesions ? ` (measured on ${l.gt_lesions} lesions)` : "";
  // A percentage rather than "1 in N": rounding 0.64 to "1 in 2" understates a
  // number the clinician is using to decide how much to trust a circle.
  const marks = l.precision == null ? "" : ` About ${pct(l.precision)} of marks are confirmed.`;
  return ` Found ${pct(l.recall)} of ${inSentence(name)} in validation${sample}.${marks}`;
}

export default function LesionBar({ lesions, active, onPick }) {
  const byKey = new Map((lesions?.classes || []).map((l) => [l.key, l]));
  const anyProvisional = LESIONS.some(
    ({ key }) => byKey.get(key)?.reliability === "provisional"
  );

  return (
    <div className="stack" style={{ gap: 8, padding: "0 16px 14px" }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {LESIONS.map(({ key, name }) => {
          const l = byKey.get(key);
          const state = l?.state ?? "not_assessed";
          const why = l?.why ?? lesions?.reason ?? "no_model";
          const tentative = l?.reliability && l.reliability !== "established";
          const on = active === key;
          const clickable = state === "found";

          const title =
            state === "found"
              ? `${name} — ${l.count} area${l.count === 1 ? "" : "s"} marked.` +
                (tentative
                  ? ` Experimental: treat these as hints, not findings.${measured(l, name)}`
                  : measured(l, name)) +
                " Click to show them."
              : state === "none"
                ? `${name} — the model ran on this image and marked none.${measured(l, name)}`
                : `${name} — not assessed. ${WHY[why] ?? ""}${measured(l, name)}`;

          return (
            <button
              key={key}
              type="button"
              className={
                `lesion-chip ${state}` +
                (tentative ? " tentative" : "") +
                (on ? " on" : "")
              }
              disabled={!clickable}
              aria-pressed={clickable ? on : undefined}
              title={title}
              onClick={() => clickable && onPick(on ? null : key)}
            >
              <span className="lesion-key">{key}</span>
              <span className="lesion-count">
                {state === "found"
                  ? `${tentative ? "~" : ""}${l.count}`
                  : state === "none"
                    ? "0"
                    : "—"}
              </span>
            </button>
          );
        })}
      </div>

      {/* The legend is not decoration. Without it a dash and a zero look like
          the same answer, and they are not. Each line shows the glyph the chip
          actually prints: a legend reading "-" while the chip draws an em dash
          sends the reader hunting for a fourth state that does not exist. */}
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
        <div style={{ marginBottom: 2 }}>What the number on a chip means</div>
        <div><strong style={SYM}>3</strong>the model marked three areas</div>
        <div><strong style={SYM}>0</strong>the model looked and marked none</div>
        <div><strong style={SYM}>—</strong>not assessed, so nothing is claimed either way</div>
        {anyProvisional && (
          <div><strong style={SYM}>~3</strong>experimental: hints to check, not findings</div>
        )}
      </div>
    </div>
  );
}