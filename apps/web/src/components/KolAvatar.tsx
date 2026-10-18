import { useState } from "react";
import { API_URL } from "../api";

/**
 * A KOL's X picture (user ask 2026-10-18), served by our own API from the worker's daily read, so
 * the browser never loads anything from X. `src` is the API's path for it ("/kol-avatars/…"), or
 * null when there is none; with none, or one that fails to load, `fallback` shows instead.
 */
export function KolAvatar({
  src,
  className,
  fallback = null,
}: {
  src: string | null | undefined;
  className: string;
  fallback?: React.ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <>{fallback}</>;
  return (
    <img
      className={className}
      src={`${API_URL}${src}`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(src)}
    />
  );
}
