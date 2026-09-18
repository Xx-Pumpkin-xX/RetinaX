// Empty in development (the Vite proxy handles /api). In production set
// VITE_API_URL to the deployed backend, e.g. https://retinax-api.onrender.com
const BASE = import.meta.env.VITE_API_URL || "";

// ngrok's free tier puts an interstitial in front of HTML traffic. JSON and
// images should not trigger it, but an interstitial on /api/me would look
// exactly like a broken login, so the header removes the doubt. Harmless
// everywhere else. It does make every request preflighted, which is why
// server.js has to name it in Access-Control-Allow-Headers.
export const API_HEADERS = { "ngrok-skip-browser-warning": "true" };

async function call(path, options = {}) {
  const res = await fetch(BASE + path, {
    credentials: "include",
    ...options,
    headers: { ...API_HEADERS, ...(options.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
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
  logout: () => call("/api/logout", { method: "POST" }),
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
  forgotPassword: (email) => call("/api/password/forgot", json("POST", { email })),
  resetPassword: (token, password) => call("/api/password/reset", json("POST", { token, password })),
};

export const API_BASE = BASE;

export const GRADES = ["No DR", "Mild NPDR", "Moderate NPDR", "Severe NPDR", "Proliferative DR"];
export const gradeVar = (g) => `var(--g${g})`;
