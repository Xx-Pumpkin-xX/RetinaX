import { useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from "react-router-dom";
import { Eye } from "lucide-react";
import { api } from "./api.js";
import Landing from "./landing/Landing.jsx";
import Login from "./pages/Login.jsx";
import Cases from "./pages/Cases.jsx";
import NewCase from "./pages/NewCase.jsx";
import CaseDetail from "./pages/CaseDetail.jsx";

export default function App() {
    const [me, setMe] = useState(undefined); // undefined = still checking
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
        api.me().then(setMe).catch(() => setMe(null));
    }, []);

    // The landing page is public and renders immediately. Waiting on the session
    // check would show a spinner to a visitor who is not signing in at all.
    // If the session check later confirms they are already signed in (e.g. they
    // logged in from another tab), bounce them straight to their worklist.
    if (location.pathname === "/") {
        return <Landing />;
    }

    if (me === undefined) {
        return (
            <div className="stack" style={{ height: "100vh", alignItems: "center", justifyContent: "center", gap: 14 }}>
                <div className="row" style={{ gap: 11 }}>
                    <Eye size={30} color="var(--accent)" />
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
            return <Login onSignedIn={setMe} />;
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
                    <Eye color="var(--accent)" />
                    <span>RetinaX<span style={{ color: "var(--accent)" }}>.ai</span></span>
                </Link>
                <div className="row" style={{ gap: 14 }}>
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
