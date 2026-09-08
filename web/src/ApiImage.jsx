import { useEffect, useState } from "react";
import { API_BASE, API_HEADERS } from "./api.js";

/**
 * An <img> whose bytes are fetched rather than loaded by the browser directly.
 *
 * Needed because a plain <img src> cannot carry request headers, and the
 * tunnel in front of the API answers header-less browser requests with an
 * interstitial HTML page instead of the image. The photograph and both
 * heatmap overlays would render broken, and the console would show a
 * successful 200 — the failure looks like nothing at all.
 *
 * Fetching gives us three things a bare <img> could not: the header, the
 * session cookie on a cross-origin request, and a real error state instead of
 * a silently broken image.
 */
export default function ApiImage({ path, alt, className, style, onError }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl;
    setUrl(null);
    setFailed(false);

    // no-store, deliberately. Express sends an ETag, so a response cached
    // while something was misconfigured comes back as a 304 and the browser
    // reuses the stored headers with it — including a wrong content type. The
    // picture then stays broken after the server is fixed, which is a very
    // expensive hour to spend. These are small images fetched one case at a
    // time; correctness is worth the re-download.
    fetch(API_BASE + path, { credentials: "include", cache: "no-store", headers: API_HEADERS })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get("content-type") || "";
        // A 200 that is not an image means something answered on the API's
        // behalf — a tunnel interstitial, a captive portal, a proxy error page.
        if (!ct.startsWith("image/")) throw new Error(`expected an image, got ${ct}`);
        return r.blob();
      })
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => {
        if (!alive) return;
        setFailed(true);
        onError?.(e);
      });

    return () => {
      alive = false;
      // Object URLs are held by the document until revoked; without this,
      // flipping between overlays leaks a blob per switch.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (failed) {
    return (
      <div className={className} style={{ ...style, display: "grid", placeItems: "center" }}>
        <span className="muted" style={{ fontSize: 13 }}>Image could not be loaded</span>
      </div>
    );
  }
  if (!url) return <div className={className} style={style} aria-busy="true" />;
  return <img className={className} style={style} src={url} alt={alt} />;
}
