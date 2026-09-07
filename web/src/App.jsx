import { useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from "react-router-dom";
import { api } from "./api.js";
import Landing from "./landing/Landing.jsx";
import Login from "./pages/Login.jsx";
import Cases from "./pages/Cases.jsx";
import NewCase from "./pages/NewCase.jsx";
import CaseDetail from "./pages/CaseDetail.jsx";

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("rx-theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

function Eye({ size = 21 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.6 12S5.2 5 12 5s10.4 7 10.4 7-3.6 7-10.4 7S1.6 12 1.6 12Z" />
      <circle cx="12" cy="12" r="3.3" />
    </svg>
  );
}

function ThemeToggle({ theme, onToggle }) {
  return (
    <button className="btn btn-ghost" style={{ height: 36, padding: "0 12px", fontSize: 13 }}
            onClick={onToggle} aria-label="Switch colour theme">
      {theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}
    </button>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = still checking
  const [theme, toggleTheme] = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  // The landing page is public and renders immediately. Waiting on the session
  // check would show a spinner to a visitor who is not signing in at all.
  if (location.pathname === "/") return <Landing />;

  if (me === undefined) {
    return (
      <div className="stack" style={{ height: "100vh", alignItems: "center", justifyContent: "center", gap: 14 }}>
        <div className="row" style={{ gap: 11 }}>
          <Eye size={30} />
          <span style={{ fontSize: 26, fontWeight: 600 }}>RetinaX<span style={{ color: "var(--accent)" }}>.ai</span></span>
        </div>
        <div className="muted">Preparing your worklist…</div>
      </div>
    );
  }

  if (!me) {
    // /reset carries the token from the emailed link in its query string, so it
    // must render Login directly — redirecting to /login would drop the token.
    if (location.pathname === "/login" || location.pathname === "/reset") {
      return <Login onSignedIn={setMe} theme={theme} onToggleTheme={toggleTheme} />;
    }
    // Anything else behind the login goes to the sign-in screen — not a blank
    // page, and not silently back to the landing.
    return <Navigate to="/login" replace />;
  }

  // Signed in but pointed at /login: send them to the worklist.
  if (location.pathname === "/login") return <Navigate to="/cases" replace />;

  async function signOut() {
    await api.logout();
    setMe(null);
    navigate("/");
  }

  return (
    <>
      <header className="header">
        <Link to="/cases" className="brand" style={{ color: "var(--ink)" }}>
          <Eye />
          <span>RetinaX<span style={{ color: "var(--accent)" }}>.ai</span></span>
        </Link>
        <div className="row" style={{ gap: 14 }}>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <span style={{ fontSize: 13.5 }}>{me.fullName}</span>
          <button className="btn btn-ghost" style={{ height: 36, padding: "0 12px", fontSize: 13 }} onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <Routes>
        <Route path="/cases" element={<Cases />} />
        <Route path="/cases/new" element={<NewCase />} />
        <Route path="/cases/:id" element={<CaseDetail />} />
        <Route path="*" element={<Navigate to="/cases" replace />} />
      </Routes>
    </>
  );
}
