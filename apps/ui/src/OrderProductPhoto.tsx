import { useState } from "react";

/** Photos are optional: an unavailable image must never prevent ordering. */
export function OrderProductPhoto({ src }: { src: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || src === failedSrc || !src.startsWith("/api/menu-images/")) return null;
  return <img className="menu-card-photo" src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />;
}
