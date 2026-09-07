import "./landing.css";
import Navbar from "./Navbar.jsx";
import Footer from "./Footer.jsx";
import Hero from "./Hero.jsx";
import PartnerLogos from "./PartnerLogos.jsx";
import AboutUs from "./AboutUs.jsx";
import Features from "./Features.jsx";
import HowItWorks from "./HowItWorks.jsx";
import ResearchCards from "./ResearchCards.jsx";
import FinalCTA from "./FinalCTA.jsx";

/**
 * The public welcome page. Everything inside .rx-landing is styled by
 * landing.css, which is scoped to that class so the demo's palette cannot
 * reach the themed application behind the login.
 */
export default function Landing() {
  return (
    <div className="rx-landing">
      <Navbar />
      <main>
        <Hero />
        <PartnerLogos />
        <AboutUs />
        <Features />
        <HowItWorks />
        <ResearchCards />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
