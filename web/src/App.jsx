import { useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from "react-router-dom";
import { Eye } from "lucide-react";
import { api } from "./api.js";
import Landing from "./landing/Landing.jsx";
import Login from "./pages/Login.jsx";
import Cases from "./pages/Cases.jsx";
import NewCase from "./pages/NewCase.jsx";
import CaseDetail from "./pages/CaseDetail.jsx";
import ChatbotPopup from "./ChatbotPopup.jsx";

export default function App() {
    const [me, setMe] = useState(undefined); // undefined = still checking
    const [newCaseDirty, setNewCaseDirty] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
        api.me().then(setMe).catch(() => setMe(null));
    }, []);

    // A session can end somewhere else: signed out in another tab, or simply
    // expired. Without this the header keeps showing a name with no session
    // behind it, and the next click fails with an error instead of taking the
    // doctor to the sign-in screen.
    useEffect(() => {
        const ended = () => setMe((current) => (current ? null : current));
        const onStorage = (e) => { if (e.key === "retinax:signed-out") ended(); };
        const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            api.me().then(setMe).catch(ended);
        };
        window.addEventListener("retinax:session-ended", ended);
        window.addEventListener("storage", onStorage);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            window.removeEventListener("retinax:session-ended", ended);
            window.removeEventListener("storage", onStorage);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

    // The landing page is public and renders immediately. Waiting on the session
    // check would show a spinner to a visitor who is not signing in at all.
    // If the session check later confirms they are already signed in (e.g. they
    // logged in from another tab), bounce them straight to their worklist.
    if (location.pathname === "/") {
        return (
            <>
                <Landing onSignOut={setMe} />
                {me && <ChatbotPopup />}
            </>
        );
    }

    if (me === undefined) {
        return (
            <div className="stack" style={{ height: "100vh", alignItems: "center", justifyContent: "center", gap: 14 }}>
                <div className="row" style={{ gap: 12 }}>
                    <span className="logo-mark logo-mark-lg" aria-hidden="true">
                        <Eye size={26} />
                    </span>
                    <span className="logo-text logo-text-lg">
                             RetinaX<span className="logo-dot">.</span>ai
                    </span>
                </div>
                <div className="muted">Preparing your worklist…</div>
            </div>
        );
    }

    if (!me) {
        // Token links must render Login directly so their query string survives.
        if (location.pathname === "/login" || location.pathname === "/reset" || location.pathname === "/verify" || location.pathname === "/login/verify") {
            return <Login onSignedIn={setMe} />;
        }
        // Anything else behind the login goes to the sign-in screen — not a blank
        // page, and not silently back to the landing. Where they were going is
        // carried along, so a session that expired mid-work resumes there.
        return (
            <Navigate to="/login" replace
                      state={{ next: location.pathname + location.search }} />
        );
    }

    // Signed in but pointed at /login: send them to the worklist.
    // Someone who pressed Upload on the landing page wanted the upload form,
    // not the worklist. Hero puts that destination in the navigation state.
    if (location.pathname === "/login") {
        return <Navigate to={location.state?.next || "/cases"} replace />;
    }

    async function signOut() {
        await api.logout();
        setMe(null);
        navigate("/");
    }

    function goToLanding(e) {
        if (!newCaseDirty) return;
        e.preventDefault();
        if (window.confirm("You have unsaved changes. Leaving this page will discard them. Continue?")) {
            navigate("/");
        }
    }

    return (
        <>
            <header className="header">
                <Link to="/" className="brand" aria-label="RetinX.ai home" onClick={goToLanding}>
                    <span className="logo-mark" aria-hidden="true">
                            <Eye size={20} />
                    </span>
                    <span className="logo-text">
                            RetinaX<span className="logo-dot">.</span>ai
                    </span>
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
                <Route path="/cases/new" element={<NewCase onDirtyChange={setNewCaseDirty} />} />
                <Route path="/cases/:id" element={<CaseDetail />} />
                <Route path="*" element={<Navigate to="/cases" replace />} />
            </Routes>
            <ChatbotPopup />
        </>
    );
}
