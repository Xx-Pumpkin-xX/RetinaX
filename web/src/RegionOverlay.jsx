/**
 * The marked areas, drawn as outlines over the photograph.
 *
 * WHY AN SVG AND NOT ANOTHER PNG
 *
 * The heatmaps are rendered by the service and arrive as pictures, which means
 * they are fixed: the only control a doctor has over them is an opacity slider,
 * and at every setting they hide the retina they are describing. Regions arrive
 * as coordinates instead, so the browser draws them — unfilled, so the tissue
 * under them stays completely visible, which is the entire reason for drawing
 * them this way. It is the FGADR figures' convention, not the jet-overlay one.
 *
 * HOW IT LINES UP
 *
 * The coordinates are in the ORIGINAL photograph's pixels. The photograph is
 * displayed with object-fit: contain, which letterboxes it inside the viewer.
 * An SVG with viewBox="0 0 W H" and preserveAspectRatio="xMidYMid meet"
 * letterboxes identically by definition, so the two agree at every window size
 * without measuring anything. Getting this wrong points at the wrong part of
 * the retina, which is worse than pointing at nothing.
 */
export default function RegionOverlay({ regions, size }) {
  if (!size?.width || !size?.height || !regions?.length) return null;

  const { width: w, height: h } = size;
  // Label size in image pixels, so it renders the same on a 1500px fundus and
  // a 3000px one.
  const font = Math.max(h * 0.022, 10);
  const pad = font * 0.45;

  return (
    <svg className="overlay regions" viewBox={`0 0 ${w} ${h}`}
         preserveAspectRatio="xMidYMid meet" role="img"
         aria-label={`${regions.length} attention region${regions.length > 1 ? "s" : ""}`}>
      {regions.map((r) => {
        const points = (r.polygon || []).map(([x, y]) => `${x},${y}`).join(" ");
        return (
          <g key={r.rank}>
            {/* A dark stroke under the bright one, so the outline stays legible
                on both the pale disc and the dark periphery. */}
            {points && (
              <>
                <polygon points={points} className="region-shadow"
                         vectorEffect="non-scaling-stroke" />
                <polygon points={points} className="region-line"
                         vectorEffect="non-scaling-stroke" />
              </>
            )}
            <rect x={r.x} y={Math.max(0, r.y - font - pad * 2)}
                  width={font * 1.6} height={font + pad * 2}
                  rx={pad} className="region-badge" />
            <text x={r.x + font * 0.8} y={Math.max(0, r.y - font - pad * 2) + font * 0.8 + pad}
                  textAnchor="middle" className="region-rank" fontSize={font}>
              {r.rank}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
