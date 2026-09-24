import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api.js";

// One screen, several states. The reset and verification states are entered by links in the
// email (/reset?token=...), so it is read from the URL rather than clicked to.
const tokenFromUrl = () => new URLSearchParams(window.location.search).get("token");

export default function Login({ onSignedIn }) {
  const location = useLocation();

  const [view, setView] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return window.location.pathname === "/verify"
      ? "verify"
      : window.location.pathname === "/login/verify"
        ? "loginVerify"
        : params.get("token")
          ? "reset"
          : "login";
  });
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [keep, setKeep] = useState(true);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(() =>
    location.state?.reason === "upload"
      ? "You need to log in first before using our product. If you haven't had an account yet, please sign up."
      : null
  );
  const [busy, setBusy] = useState(false);

  const DEMO = { email: "quang@retinax.ai", password: "retinax123" };

  function go(next) {
    setEmail("");
    setPassword("");
    setView(next);
    setError(null);
    setNote(null);
  }

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const submitLogin = (e) => {
    e.preventDefault();
    run(async () => {
      const out = await api.login(email, password, keep);
      if (out?.verificationRequired) {
        setNote(out.delivery === "email"
          ? "We sent a sign-in approval link to your email. Open it on this browser to continue."
          : "Email is not configured, so the sign-in approval link was not sent. Ask the server owner for the link.");
        return;
      }
      onSignedIn(out);
    });
  };

  const submitForgot = (e) => {
    e.preventDefault();
    run(async () => {
      const out = await api.forgotPassword(email);
      setNote(
        out?.delivery === "email"
          ? "If that address has an account, a reset link is on its way. It expires in 30 minutes."
          : "This build has no email provider configured, so no link was sent. " +
            "The reset link is written to the server log — ask whoever runs this instance for it."
      );
    });
  };

  const submitSignup = (e) => {
    e.preventDefault();
    run(async () => {
      const out = await api.signup(fullName, email, password);
      setEmail(email);
      setNote("Your account was created. Sign in to confirm this browser and continue.");
      setView("login");
    });
  };

  const submitVerify = () => run(async () => {
    await api.verifyEmail(new URLSearchParams(window.location.search).get("token"));
    window.history.replaceState({}, "", "/login");
    setView("login");
    setNote("Email confirmed. You can sign in now.");
  });

  const submitLoginVerify = () => run(async () => {
    const out = await api.verifyLogin(new URLSearchParams(window.location.search).get("token"));
    window.history.replaceState({}, "", "/login");
    onSignedIn(out);
  });

  const submitReset = (e) => {
    e.preventDefault();
    run(async () => {
      await api.resetPassword(tokenFromUrl(), password);
      window.history.replaceState({}, "", "/");
      setPassword("");
      go("login");
      setNote("Password changed. Sign in with the new one.");
    });
  };

  return (
    <div className="stack" style={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: 22 }}>
      <div className="stack" style={{ width: 400, gap: 22 }}>
        <Link to="/" className="linkish" style={{ alignSelf: "flex-start", fontSize: 13 }}>
          ← Back to RetinaX.ai
        </Link>

        <div className="stack" style={{ gap: 4 }}>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.5px" }}>
            RetinaX<span style={{ color: "var(--accent)" }}>.ai</span>
          </div>
          <div className="muted" style={{ fontSize: 13.5 }}>Diabetic retinopathy screening</div>
        </div>

        {(view === "login" || view === "signup") && (
          <div className="card stack" style={{ padding: 0, gap: 0, overflow: "hidden" }}>
            <div className="seg" style={{ border: "none", borderRadius: 0,
                                          borderBottom: "1px solid var(--line)" }}>
              <button type="button" style={{ flex: 1, height: 46 }}
                      aria-pressed={view === "login"} onClick={() => go("login")}>Log in</button>
              <button type="button" style={{ flex: 1, height: 46 }}
                      aria-pressed={view === "signup"} onClick={() => go("signup")}>Sign up</button>
            </div>

        {view === "signup" && (
          <form className="stack" style={{ padding: 26, gap: 16 }} onSubmit={submitSignup}>
            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="name">Full name</label>
              <input id="name" className="input" value={fullName} placeholder="Dr. Nguyen Van A"
                     onChange={(e) => setFullName(e.target.value)} autoComplete="name" required />
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="su-email">Email</label>
              <input id="su-email" className="input" type="email" value={email}
                     onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="su-password">Password</label>
              <input id="su-password" className="input" type="password" value={password}
                     onChange={(e) => setPassword(e.target.value)}
                     autoComplete="new-password" required />
              <div className="muted" style={{ fontSize: 12 }}>At least 8 characters.</div>
            </div>

            {error && <div className="err">{error}</div>}

            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Creating your account…" : "Create account"}
            </button>
            <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              Your worklist starts empty. Upload a fundus photograph and the
              model grades it — you only ever see cases you uploaded yourself.
            </div>
          </form>
        )}

        {view === "login" && (
          <form className="stack" style={{ padding: 26, gap: 16 }} onSubmit={submitLogin}>
            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" className="input" type="email" value={email}
                     onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <label className="label" htmlFor="password">Password</label>
                <button type="button" className="linkish" onClick={() => go("forgot")}>Forgot password?</button>
              </div>
              <input id="password" className="input" type="password" value={password}
                     onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>

            <label className="row" style={{ gap: 9, fontSize: 13.5, cursor: "pointer" }}>
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              Keep me signed in
            </label>

            {error && <div className="err">{error}</div>}
            {note && <div className="note">{note}</div>}

            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Log in"}
            </button>

            <button type="button" className="linkish" style={{ alignSelf: "center", fontSize: 12.5 }}
                    onClick={() => { setEmail(DEMO.email); setPassword(DEMO.password); setError(null); }}>
              Use the demo account
            </button>
          </form>
        )}
          </div>
        )}

        {view === "forgot" && (
          <form className="card stack" style={{ padding: 26, gap: 16 }} onSubmit={submitForgot}>
            <div className="stack" style={{ gap: 5 }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Reset your password</div>
              <div className="muted" style={{ fontSize: 13 }}>
                We will email you a link that works once and expires in 30 minutes.
              </div>
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="forgot-email">Email</label>
              <input id="forgot-email" className="input" type="email" value={email}
                     onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </div>

            {error && <div className="err">{error}</div>}
            {note && <div className="note">{note}</div>}

            <div className="row" style={{ gap: 10 }}>
              <button className="btn" type="submit" disabled={busy} style={{ flex: 1 }}>
                {busy ? "Sending…" : "Send reset link"}
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => go("login")}>Back</button>
            </div>
          </form>
        )}

        {view === "verify" && (
          <div className="card stack" style={{ padding: 26, gap: 16 }}>
            <div className="stack" style={{ gap: 5 }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Confirm your email</div>
              <div className="muted" style={{ fontSize: 13 }}>Click below to confirm this email address.</div>
            </div>
            {error && <div className="err">{error}</div>}
            <button className="btn" type="button" disabled={busy} onClick={submitVerify}>
              {busy ? "Confirming…" : "Confirm email"}
            </button>
          </div>
        )}

        {view === "loginVerify" && (
          <div className="card stack" style={{ padding: 26, gap: 16 }}>
            <div className="stack" style={{ gap: 5 }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Approve this sign-in</div>
              <div className="muted" style={{ fontSize: 13 }}>Click below to trust this browser for 30 days.</div>
            </div>
            {error && <div className="err">{error}</div>}
            <button className="btn" type="button" disabled={busy} onClick={submitLoginVerify}>
              {busy ? "Approving…" : "Approve sign-in"}
            </button>
          </div>
        )}

        {view === "reset" && (
          <form className="card stack" style={{ padding: 26, gap: 16 }} onSubmit={submitReset}>
            <div className="stack" style={{ gap: 5 }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Choose a new password</div>
              <div className="muted" style={{ fontSize: 13 }}>At least 8 characters.</div>
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="new-password">New password</label>
              <input id="new-password" className="input" type="password" value={password}
                     onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </div>

            {error && <div className="err">{error}</div>}

            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Set new password"}
            </button>
          </form>
        )}

        <div className="disclaimer">
          <span aria-hidden="true">⚠</span>
          <div><strong>Decision support only.</strong> The AI can be wrong. Every grade must be
          confirmed by a clinician before it is used.</div>
        </div>
      </div>
    </div>
  );
}