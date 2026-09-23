import "./landing.css";
import Navbar from "./Navbar.jsx";
import Footer from "./Footer.jsx";
import Hero from "./Hero.jsx";
import PartnerLogos from "./PartnerLogos.jsx";
import HowItWorks from "./HowItWorks.jsx";
import ResearchCards from "./ResearchCards.jsx";


/**
 * The public welcome page. Everything inside .rx-landing is styled by
 * landing.css, which is scoped to that class so the demo's palette cannot
 * reach the themed application behind the login.
 */
export default function Landing({ onSignOut }) {
  return (
    <div className="rx-landing">
      <Navbar onSignOut={onSignOut} />
      <main>
        <Hero />
        <HowItWorks />
        <ResearchCards />
        <PartnerLogos />
      </main>
      <Footer />
    </div>
  );
}
