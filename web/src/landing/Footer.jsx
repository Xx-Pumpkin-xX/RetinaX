import { Link } from "react-router-dom";
import { Eye } from "lucide-react";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <Link to="/" className="brand brand-light">
            <span className="brand-mark brand-mark-light"><Eye size={18} strokeWidth={2.2} /></span>
            <span className="brand-text">RetinaX<span className="brand-dot">.</span>ai</span>
          </Link>
          <p className="footer-note">
            Research prototype for explainable diabetic-retinopathy grading.
            Clinical decision support only — not a medical device and not
            intended for autonomous diagnosis.
          </p>
        </div>

        <div className="footer-col">
          <h4>Project</h4>
          <span>Lesion-Aware Explainable AI</span>
          <span>DR Grading on Fundus Images</span>
          <span>USTH</span>
        </div>

        <div className="footer-col">
          <h4>Status</h4>
          <span>Research prototype</span>
          <span>Decision support only</span>
          
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© 2026 RetinaX.ai</span>
        <span>Clinical decision support only.</span>
      </div>
    </footer>
  );
}
