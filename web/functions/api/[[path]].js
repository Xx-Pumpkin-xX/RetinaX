/**
 * Proxy /api/* through Cloudflare Pages to the API host.
 *
 * Without this the browser is talking to two different sites — the page on
 * pages.dev, the API on a tunnel hostname — so the session cookie is a
 * third-party cookie. Safari blocks those outright, Firefox blocks them by
 * default, Chrome blocks them in incognito and is phasing them out generally.
 * The symptom is precise and misleading: login succeeds and the UI shows the
 * doctor's name, because the response body carried it, and then every request
 * after that is 401 because the cookie was never stored.
 *
 * Proxied, the browser only ever sees one origin. The cookie is first-party,
 * CORS stops applying, and the tunnel's browser interstitial cannot appear
 * because the request no longer looks like a browser navigation to it.
 *
 * Set API_ORIGIN in the Pages project (Settings -> Environment variables) to
 * the tunnel in front of prts-0 — no trailing slash. A cloudflared quick
 * tunnel gets a new hostname every time it starts, so this value has to be
 * updated and the deployment retried whenever the tunnel is restarted.
 */
export async function onRequest(context) {
  const { request, env } = context;

  const origin = (env.API_ORIGIN || "").replace(/\/$/, "");
  if (!origin) {
    return new Response(
      JSON.stringify({ error: "API_ORIGIN is not set on this Pages project" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const url = new URL(request.url);
  const target = origin + url.pathname + url.search;

  // Carry the method, body and headers through unchanged. Passing `request`
  // as the init keeps the body a stream, so a 12 MB fundus upload is not
  // buffered in the worker.
  // This proxy is the LAST place the browser's real Origin is visible: the line
  // below overwrites it, and the API has no Origin check of its own. So a
  // cross-site write has to be refused here or it is never refused at all.
  //
  // The session cookie is SameSite=None, which means the browser attaches it to
  // cross-site requests too. A multipart POST is a CORS-"simple" request, so it
  // is sent without a preflight and reaches the API fully authenticated. That is
  // textbook CSRF, and this block is what closes it.
  //
  // Only an explicit signal counts as evidence. A missing Origin and a missing
  // Sec-Fetch-Site are normal on same-origin navigations, so absence is allowed
  // through; only a header that positively says "another site" is refused.
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const site = request.headers.get("sec-fetch-site");
    const browserOrigin = request.headers.get("origin");
    const crossSite = site
      ? (site !== "same-origin" && site !== "same-site" && site !== "none")
      : Boolean(browserOrigin && browserOrigin !== url.origin);
    if (crossSite) {
      return new Response(
        JSON.stringify({
          error: "This request did not come from the RetinaX.ai site.",
          code: "CROSS_SITE_BLOCKED",
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }
  }

  const proxied = new Request(target, request);
  // Send the site's own origin rather than whatever the browser put there, so
  // the API sees one consistent value. The check above is what makes this safe.
  proxied.headers.set("origin", url.origin);
  proxied.headers.delete("host");

  // Never trust client-supplied copies of the internal rate-limit headers.
  // If API_PROXY_SECRET is configured on both Pages and the API host, forward
  // Cloudflare's authenticated client IP together with that shared secret.
  proxied.headers.delete("x-retinax-client-ip");
  proxied.headers.delete("x-retinax-proxy-secret");
  if (env.API_PROXY_SECRET) {
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) proxied.headers.set("x-retinax-client-ip", clientIp);
    proxied.headers.set("x-retinax-proxy-secret", env.API_PROXY_SECRET);
  }

  const response = await fetch(proxied);

  // Set-Cookie arrives with SameSite=None; Secure, which is correct
  // cross-site and still valid first-party, so it is passed through as-is.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
