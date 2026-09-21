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
 * Set API_ORIGIN in the Pages project (Settings -> Environment variables), e.g.
 * https://acuteness-finless-pluck.ngrok-free.dev — no trailing slash.
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
  const proxied = new Request(target, request);
  proxied.headers.set("ngrok-skip-browser-warning", "true");
  // The API compares Origin against WEB_ORIGIN. Send the site's own origin
  // rather than whatever the browser put there.
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
