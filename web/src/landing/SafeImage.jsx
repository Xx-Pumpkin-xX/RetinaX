import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";

/** Renders a labelled placeholder instead of a broken-image icon. */
export default function SafeImage({ src, alt, label, className, style }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className={`img-fallback ${className ?? ""}`} style={style}>
        <ImageIcon size={26} strokeWidth={1.6} />
        <span>{label ?? alt}</span>
      </div>
    );
  }

  return (
    <img src={src} alt={alt} className={className} style={style}
         loading="lazy" onError={() => setFailed(true)} />
  );
}
