import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Eye } from "lucide-react";
import { api } from "../api.js";

export default function Navbar({ onSignOut }) {
  const [scrolled, setScrolled] = useState(false);
  const [me, setMe] = useState(undefined); // undefined = still checking, null = not signed in

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll);
  }, []);


  async function signOut() {
    await api.logout();
    setMe(null);
    // update `me` to null in App
    onSignOut(null);
  }

  return (
    <header className={`navbar ${scrolled ? "navbar-scrolled" : "navbar-transparent"}`}>
      <div className="container navbar-inner">
        <Link to="/" className="brand" aria-label="RetinX.ai home">
          <span className="brand-mark" aria-hidden="true">
            <Eye size={20} />
          </span>
          <span className="brand-text">
            RetinaX<span className="brand-dot">.</span>ai
          </span>
        </Link>

        <nav className="nav-links" aria-label="Main navigation">
          {me && (
            <Link to="/cases">
              <button className="btn btn-primary btn-sm nav-cta">
                My cases
              </button>
            </Link>
          )}
          {me ? (
            <button className="btn btn-primary btn-sm nav-cta" onClick={signOut}>
              Sign out
            </button>
          ) : (
            <Link to="/login">
              <button className="btn btn-primary btn-sm nav-cta">
                Sign in
              </button>
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
