/**
 * The marked areas, drawn as plain rectangles over the photograph.
 *
 * WHY A BOX AND NOT A TRACED OUTLINE
 *
 * A contour that follows the activation's own shape looks more precise, and
 * that is exactly the problem: it reads as a lesion boundary. This map comes
 * from a GRADING model. It shows where the network's evidence for a grade
 * concentrated - correlated with lesions, but not a segmentation of them. A
 * rectangle cannot be mistaken for a traced lesion. It says "look in here",
 * which is the strongest honest claim available. It is also what the FGADR
 * figures do.
 *
 * WHY UNFILLED
 *
 * A jet overlay becomes easy to read at exactly the moment it becomes
 * impossible to see the retina underneath. An empty box leaves the tissue
 * completely visible, which is the whole point of marking it.
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
export default function RegionOverlay({ regions, size }) {
  if (!size?.width || !size?.height || !regions?.length) return null;

  const { width: w, height: h } = size;
  // Label size in image pixels, so it looks the same on a 548px fundus and a
  // 3000px one.
  const font = Math.max(h * 0.030, 9);
  const pad = font * 0.3;

  return (
    <svg className="overlay regions" viewBox={`0 0 ${w} ${h}`}
         preserveAspectRatio="xMidYMid meet" role="img"
         aria-label={`${regions.length} attention region${regions.length > 1 ? "s" : ""}`}>
      {regions.map((r, i) => {
        // rank comes from the service, but older stored rows predate it, so the
        // position in the list - already sorted by strength - is the fallback.
        const n = r.rank ?? i + 1;
        const labelY = Math.max(0, r.y - font - pad);
        return (
          <g key={n}>
            {/* A dark stroke under the bright one, so the box stays legible on
                both the pale disc and the dark periphery. */}
            <rect x={r.x} y={r.y} width={r.w} height={r.h}
                  className="region-shadow" vectorEffect="non-scaling-stroke" />
            <rect x={r.x} y={r.y} width={r.w} height={r.h}
                  className="region-line" vectorEffect="non-scaling-stroke" />
            <rect x={r.x} y={labelY} width={font * 1.5} height={font + pad}
                  className="region-badge" />
            <text x={r.x + font * 0.75} y={labelY + font * 0.82 + pad / 2}
                  textAnchor="middle" className="region-rank" fontSize={font}>
              {n}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
