const PARTNERS = [
  { name: "USTH", src: "/assets/usth-logo.png", href: "https://usth.edu.vn/en/" },
  { name: "CIE", src: "/assets/cie-logo.png", href: "https://usth.edu.vn/cie/" },
  { name: "Analytics Everywhere Lab", src: "/assets/aelab-logo.png", href: "https://www.cs.unb.ca/~hcao3/" },
  { name: "UNB", src: "/assets/unb-logo.png", href: "https://www.unb.ca/" },
];

export default function PartnerLogos() {
  return (
    <section className="partners">
      <div className="container">
        <div className="partners-box">
          <p className="partners-title">Research affiliations &amp; support</p>
          <div className="partners-row">
            {PARTNERS.map((p) => (
              <a key={p.name} className="partner" href={p.href} target="_blank" rel="noopener noreferrer">
                <img src={p.src} alt={p.name} className="partner-logo" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}