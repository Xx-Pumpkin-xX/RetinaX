// Production must stay same-origin so the Pages Function can proxy /api and
// keep the session cookie first-party. A direct API URL makes login appear to
// work while the browser silently drops the cross-site session cookie.
const BASE = import.meta.env.PROD ? "" : (import.meta.env.VITE_API_URL || "");

// Headers every API call carries. Empty today: it held ngrok's
// interstitial-skip header, and the tunnel in front of prts-0 is cloudflared
// now, which serves the API directly. Kept as the one place to add such a
// header if the tunnel is ever swapped again - and kept empty on purpose,
// because a custom header makes every cross-origin request preflighted.
export const API_HEADERS = {};

const AUTH_PATHS = [
  "/api/login",
  "/api/signup",
  "/api/password/forgot",
  "/api/password/reset",
];

async function call(path, options = {}) {
  const res = await fetch(BASE + path, {
    credentials: "include",
    ...options,
    headers: { ...API_HEADERS, ...(options.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401 on anything but the sign-in endpoints means the session cookie is
    // gone. Announce it once so App can return to the sign-in screen rather
    // than leaving a stale name in the header.
    if (res.status === 401 && !AUTH_PATHS.includes(path)) {
      window.dispatchEvent(new Event("retinax:session-ended"));
    }
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body.code ?? null;
    throw err;
  }
  return body;
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  me: () => call("/api/me"),
  login: (email, password, keepSignedIn) =>
    call("/api/login", json("POST", { email, password, keepSignedIn })),
  logout: async () => {
    const out = await call("/api/logout", { method: "POST" });
    // Other tabs of this site are listening for this key, so they leave the
    // worklist at the same moment rather than at their next click.
    try { localStorage.setItem("retinax:signed-out", String(Date.now())); } catch {}
    return out;
  },
  cases: () => call("/api/cases"),
  case: (id) => call(`/api/cases/${id}`),
  createCase: (formData) => call("/api/cases", { method: "POST", body: formData }),
  mark: (id, payload) => call(`/api/cases/${id}/mark`, json("POST", payload)),

  // chatbot implementation 
  chat: (id, message, history = []) =>
  call(
    `/api/cases/${id}/chat`,
    json("POST", {
      message,
      history,
    })
  ),
  
  // General application assistant. Non-streaming keeps the floating popup
  // simple while reusing the existing authenticated /api/chat endpoint.
  assistantChat: (messages) =>
    call("/api/chat?stream=0", json("POST", { messages })),

  updateDetails: (id, payload) => call(`/api/cases/${id}/details`, json("POST", payload)),
  // A reviewed case carries a recorded assessment, so the request carries a
  // second, explicit signal instead of arriving as a bare DELETE.
  deleteCase: (id, confirm) =>
    call(`/api/cases/${id}`, confirm ? json("DELETE", { confirm }) : { method: "DELETE" }),
  regrade: (id) => call(`/api/cases/${id}/regrade`, { method: "POST" }),
  // ccem:false redraws Grad-CAM++ only — seconds, not minutes.
  explain: (id, { ccem = true } = {}) =>
    call(`/api/cases/${id}/explain${ccem ? "" : "?ccem=0"}`, { method: "POST" }),
  signup: (fullName, email, password) =>
    call("/api/signup", json("POST", { fullName, email, password })),
  verifyEmail: (token) => call(`/api/email/verify?token=${encodeURIComponent(token)}`),
  resendVerification: (email) => call("/api/email/resend", json("POST", { email })),
  verifyLogin: (token) => call(`/api/login/verify?token=${encodeURIComponent(token)}`),
  forgotPassword: (email) => call("/api/password/forgot", json("POST", { email })),
  resetPassword: (token, password) => call("/api/password/reset", json("POST", { token, password })),
};

export const API_BASE = BASE;

export const GRADES = ["No DR", "Mild NPDR", "Moderate NPDR", "Severe NPDR", "Proliferative DR"];
export const gradeVar = (g) => `var(--g${g})`;
