import { useState } from "react";
import { api } from "../api.js";

// One screen, three states. The reset state is entered by the link in the
// email (/reset?token=...), so it is read from the URL rather than clicked to.
const tokenFromUrl = () => new URLSearchParams(window.location.search).get("token");

export default function Login({ onSignedIn, theme, onToggleTheme }) {
  const [view, setView] = useState(() => (tokenFromUrl() ? "reset" : "login"));
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("quang@retinax.ai");
  const [password, setPassword] = useState("retinax123");
  const [keep, setKeep] = useState(true);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);

  const DEMO = { email: "quang@retinax.ai", password: "retinax123" };

  function go(next) {
    // The login tab is prefilled with the demo account so a judge can get in
    // without typing. On the sign-up tab that prefill is nonsense — it would
    // invite someone to register an address that already exists.
    if (next === "signup") {
      setEmail("");
      setPassword("");
    } else if (next === "login" && !email && !password) {
      setEmail(DEMO.email);
      setPassword(DEMO.password);
    }
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
    run(async () => onSignedIn(await api.login(email, password, keep)));
  };

  const submitForgot = (e) => {
    e.preventDefault();
    run(async () => {
      await api.forgotPassword(email);
      // Deliberately the same message whether or not the address is registered.
      setNote("If that address has an account, a reset link is on its way. It expires in 30 minutes.");
    });
  };

  const submitSignup = (e) => {
    e.preventDefault();
    run(async () => onSignedIn(await api.signup(fullName, email, password)));
  };

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
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="stack" style={{ gap: 4 }}>
            <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.5px" }}>
              RetinaX<span style={{ color: "var(--accent)" }}>.ai</span>
            </div>
            <div className="muted" style={{ fontSize: 13.5 }}>Diabetic retinopathy screening</div>
          </div>
          <button className="btn btn-ghost" style={{ height: 36, padding: "0 12px", fontSize: 13 }} onClick={onToggleTheme}>
            {theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}
          </button>
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
