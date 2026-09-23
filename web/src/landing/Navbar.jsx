import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Eye } from "lucide-react";
import { api } from "../api.js";

const LINKS = [
  { id: "how-it-works", label: "How It Works" },
];

export default function Navbar({ onSignOut }) {
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState("");
  const [me, setMe] = useState(undefined); // undefined = still checking, null = not signed in

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 8);
      const current = LINKS.map((l) => document.getElementById(l.id))
        .filter(Boolean)
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top <= 140 && rect.bottom >= 140;
        });
      setActive(current ? current.id : "");
    };
    window.addEventListener("scroll", onScroll);
  }, []);

  const goToSection = (id) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });

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
          {LINKS.map((link) => (
            <button key={link.id} type="button"
              className={`nav-link ${active === link.id ? "nav-link-active" : ""}`}
              onClick={() => goToSection(link.id)}>
              {link.label}
            </button>
          ))}
          {me ? (
            <button className="btn btn-primary btn-sm nav-cta" onClick={signOut}>
              Sign out
            </button>
          ) : (
            <Link to="/login" className="btn btn-primary btn-sm nav-cta">Sign in</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
