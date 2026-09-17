/**
 * The marked areas, drawn as outlines around the red parts of the map.
 *
 * WHAT IS ACTUALLY BEING OUTLINED
 *
 * The service thresholds the activation at the level that renders red on the
 * jet colormap and traces the boundary of each area above it. So this outline
 * and the CAM overlay are the same statement shown twice: switch between them
 * and the shapes coincide. That is deliberate. Two views that disagreed would
 * leave a clinician with no way to tell which one to believe.
 *
 * WHY UNFILLED
 *
 * A jet overlay becomes easy to read at exactly the moment it becomes
 * impossible to see the retina underneath. An empty outline leaves the tissue
 * completely visible, which is the whole point of marking it.
 *
 * WHAT IT IS NOT
 *
 * It is not a lesion boundary. This map comes from a GRADING model - it shows
 * where the evidence for a grade concentrated, which is correlated with
 * lesions but is not a segmentation of them. The boundary is grown slightly by
 * the service for that reason, and the UI calls them attention regions.
 *
 * HOW IT LINES UP
 *
 * Coordinates are in the ORIGINAL photograph's pixels. The photograph renders
 * with object-fit: contain, which letterboxes it inside the viewer. An SVG
 * with viewBox="0 0 W H" and preserveAspectRatio="xMidYMid meet" letterboxes
 * identically by definition, so the two agree at every window size without
 * measuring anything. Getting this wrong points at the wrong part of the
 * retina, which is worse than pointing at nothing.
 */
// tone picks the stroke colour: "region" for the grading model's attention,
// "lesion" for a lesion segmentation. They are different claims about the eye
// and should not arrive in the same colour, even though only one shows at once.
export default function RegionOverlay({ regions, size, tone = "region", label }) {
  if (!size?.width || !size?.height || !regions?.length) return null;

  const { width: w, height: h } = size;

  return (
    <svg className={`overlay regions ${tone}`} viewBox={`0 0 ${w} ${h}`}
         preserveAspectRatio="xMidYMid meet" role="img"
         aria-label={label ?? `${regions.length} attention region${regions.length > 1 ? "s" : ""}`}>
      {regions.map((r, i) => {
        // rank comes from the service; rows stored before it existed fall back
        // to their position in the list, which is already sorted by strength.
        const n = r.rank ?? i + 1;
        const poly = r.polygon?.length >= 3 ? r.polygon : null;
        const points = poly?.map(([x, y]) => `${x},${y}`).join(" ");

        return (
          <g key={n}>
            {/* A dark stroke under the bright one, so the outline stays
                legible over both the pale disc and the dark periphery. */}
            {poly ? (
              <>
                <polygon points={points} className="region-shadow"
                         vectorEffect="non-scaling-stroke" />
                <polygon points={points} className="region-line"
                         vectorEffect="non-scaling-stroke" />
              </>
            ) : (
              <>
                <rect x={r.x} y={r.y} width={r.w} height={r.h}
                      className="region-shadow" vectorEffect="non-scaling-stroke" />
                <rect x={r.x} y={r.y} width={r.w} height={r.h}
                      className="region-line" vectorEffect="non-scaling-stroke" />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
