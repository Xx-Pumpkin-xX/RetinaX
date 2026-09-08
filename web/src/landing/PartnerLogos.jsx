import SafeImage from "./SafeImage.jsx";

/**
 * `href` is optional: a partner with one becomes a link, a partner without
 * stays a plain logo. Better a logo that does nothing than a logo that sends a
 * judge somewhere wrong.
 */
const PARTNERS = [
  {
    name: "USTH",
    src: "/assets/usth-logo.png",
    href: "https://usth.edu.vn/en/",
    title: "University of Science and Technology of Hanoi",
  },
  {
    name: "CIE",
    src: "/assets/cie-logo.png",
    href: "",              // TODO: the Center for Innovation and Entrepreneurship's URL
    title: "Center for Innovation and Entrepreneurship",
  },
  {
    name: "Analytics Everywhere Lab",
    src: "/assets/aelab-logo.png",
    href: "https://www.cs.unb.ca/~hcao3/",
    title: "Analytics Everywhere Lab, University of New Brunswick",
  },
  {
    name: "UNB",
    src: "/assets/unb-logo.png",
    href: "https://www.unb.ca/",
    title: "University of New Brunswick",
  },
];

export default function PartnerLogos() {
  return (
    <section className="partners">
      <div className="container">
        <div className="partners-box">
          <p className="partners-title">Research affiliations &amp; support</p>
          <div className="partners-row">
            {PARTNERS.map((partner) => {
              const logo = (
                <SafeImage src={partner.src} alt={partner.name}
                           label={partner.name} className="partner-logo" />
              );
              // rel="noopener" is not optional on a target="_blank" link: without
              // it the opened page gets a handle on this one through window.opener.
              return partner.href ? (
                <a className="partner" key={partner.name} href={partner.href}
                   target="_blank" rel="noopener noreferrer"
                   title={partner.title} aria-label={partner.title}>
                  {logo}
                </a>
              ) : (
                <div className="partner" key={partner.name} title={partner.title}>
                  {logo}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
