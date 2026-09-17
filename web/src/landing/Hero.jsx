import { useNavigate } from "react-router-dom";
import { Layers, ScanEye, Sparkles, UploadCloud } from "lucide-react";
import SafeImage from "./SafeImage.jsx";
import { api } from "../api.js";

export default function Hero() {
    const navigate = useNavigate();

    const handleUploadClick = async () => {
        try {
            await api.me(); // throws if not signed in (401)
            navigate("/cases");
        } catch {
            navigate("/login", { state: { reason: "upload" } });
        }
    };

    return (
        <section className="hero-dark">
            <div className="container hero-grid">
                <div className="hero-stack">
                    <div className="hero-img-card hero-img-main">
                        <SafeImage src="/assets/hero-fundus.jpg" alt="Retinal image" label="hero-fundus.jpg" />
                    </div>

                    <div className="hero-img-card hero-img-overlay">
                        <SafeImage src="/assets/hero-overlay.png" alt="Lesion-aware explanation overlay" label="hero-overlay.png" />
                    </div>

                    <span className="float-badge badge-a"><Sparkles size={14} /> Explainable AI</span>
                    <span className="float-badge badge-b"><ScanEye size={14} /> Lesion-aware</span>
                </div>

                <div className="hero-copy">
                    <h1 className="h1">
                        AI tool assisting doctors in screening diabetic retinopathy
                    </h1>

                    <p className="hero-sub">
                        Click the Upload button to upload the fundus image. Our AI will process it
                        and send back the screening result to you.
                    </p>

                    <div className="hero-actions">
                        <button onClick={handleUploadClick} className="btn btn-retina btn-lg">
                            Upload <UploadCloud size={17} />
                        </button>
                    </div>

                    <p className="disclaimer">
                        Research prototype — clinical decision support only.
                    </p>
                </div>
            </div>
        </section>
    );
}
