/**
 * Sending email, or honestly admitting that we cannot.
 *
 * No SDK: Resend and most providers are one HTTPS POST, and a dependency for
 * that is a dependency to keep patched.
 *
 * The important behaviour is the failure case. Until this is configured the
 * password-reset screen used to say "a reset link is on its way" and then send
 * nothing, which is the worst of both worlds — the user waits for something
 * that was never coming. isConfigured() lets the caller say what is true.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
// Overridable so the send path can be exercised against a local stub without
// editing this file — and so a different provider with the same shape can be
// swapped in without a code change.
const MAIL_API_URL = process.env.MAIL_API_URL || "https://api.resend.com/emails";

export const isConfigured = () => Boolean(RESEND_API_KEY && MAIL_FROM);

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
    const res = await fetch(MAIL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
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
