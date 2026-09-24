const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || "";
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "";
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || "";
const GMAIL_USER = process.env.GMAIL_USER || "";
const MAIL_FROM = process.env.MAIL_FROM || GMAIL_USER;
const MAIL_TIMEOUT_MS = 150 * 1000;

const gmailConfigured = () => Boolean(
  GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN && GMAIL_USER && MAIL_FROM
);

export const isConfigured = () => gmailConfigured();

async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google OAuth returned ${res.status}`);
  return (await res.json()).access_token;
}

function rawMessage({ to, subject, text }) {
  const message = [
    `From: ${MAIL_FROM}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    text,
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
}

/**
 * @returns {Promise<{delivered: boolean, reason?: string}>}
 * Never throws: a password-reset request must answer the same way whether or
 * not the address exists, and an exception here would leak that difference
 * through a 500.
 */
export async function sendMail({ to, subject, text }) {
  if (!isConfigured()) {
    return { delivered: false, reason: "not configured" };
  }
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/send`,
      {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: rawMessage({ to, subject, text }) }),
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[mail] provider refused: ${res.status} ${body.slice(0, 200)}`);
      return { delivered: false, reason: `provider returned ${res.status}` };
    }
    return { delivered: true };
  } catch (err) {
    console.warn("[mail] send failed:", err.message);
    return { delivered: false, reason: err.message };
  }
}
