import { useState, type ReactNode } from "react";
import { tokenImageSources } from "../format";
import { useImagePreview } from "./ImagePreview";

/**
 * A token's launcher-supplied image, tried in order from tokenImageSources (thumbnail, the
 * original URL, a second IPFS gateway), and `fallback` (the initials) once none loads. https
 * only, lazy, and no referrer sent to whoever hosts it. With `preview`, hovering it on desktop
 * shows it large beside it, as the alert card's avatar does.
 */
export function TokenImage({
  url,
  size,
  fallback,
  className,
  width,
  height,
  eager = false,
  preview = false,
}: {
  url: string | null | undefined;
  /** The thumbnail's side in px, usually twice the shown size for sharp screens. */
  size: number;
  fallback: ReactNode;
  className?: string;
  width: number;
  height: number;
  eager?: boolean;
  preview?: boolean;
}) {
  const sources = tokenImageSources(url, size);
  // Keyed by the URL, so a card that gets its image later starts again from the thumbnail.
  const [failed, setFailed] = useState<{ url: string; count: number }>({ url: "", count: 0 });
  const attempt = failed.url === url ? failed.count : 0;
  const src = sources[attempt];
  const big = useImagePreview(preview && url?.startsWith("https://") ? url : null, src ?? null);
  if (!src) return <>{fallback}</>;
  return (
    <>
      <img
        className={className}
        src={src}
        alt=""
        width={width}
        height={height}
        loading={eager ? undefined : "lazy"}
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => {
          big.close();
          setFailed({ url: url ?? "", count: attempt + 1 });
        }}
        {...(preview ? big.bind : {})}
      />
      {big.node}
    </>
  );
}
