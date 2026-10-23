import { useEffect, useRef, useState, type ReactNode } from "react";
import { tokenImageSources } from "../format";
import { useImagePreview } from "./ImagePreview";

/**
 * How long a source may sit unanswered once it is on screen before the next is tried. A gateway
 * that never answers (one throttling, or a pin it is still looking for) otherwise held the avatar
 * blank until the browser gave up, often a minute or more. The last source is never cut short.
 */
export const STALL_MS = 3500;

/**
 * Which source loaded for each image, and past which none did, for this page's life: a card
 * that mounts again (a list re-rendering, a tab switched back, the same coin on another surface)
 * starts from the one that worked instead of waiting through the ones that failed again.
 */
const settled = new Map<string, number>();
const SETTLED_MAX = 2000;

function remember(key: string, index: number) {
  if (settled.size >= SETTLED_MAX) settled.delete(settled.keys().next().value!);
  settled.set(key, index);
}

/** For tests. */
export function forgetTokenImages() {
  settled.clear();
}

/**
 * A token's image, tried in order from tokenImageSources (thumbnail, Pump.fun's CDN for its
 * coins, a fast IPFS gateway, the original URL, a second gateway), moving on when one fails or
 * stalls, and `fallback` (the initials) once none loads. It shows a soft pulse while loading.
 * https only, lazy, and no referrer sent to whoever hosts it. With `preview`, hovering it on
 * desktop shows it large beside it, as the alert card's avatar does.
 */
export function TokenImage({
  url,
  mint,
  size,
  fallback,
  className,
  width,
  height,
  eager = false,
  preview = false,
}: {
  url: string | null | undefined;
  /** The token's mint: a Pump.fun coin's image comes from Pump.fun's CDN when its URL fails or is missing. */
  mint?: string | null;
  /** The thumbnail's side in px, usually twice the shown size for sharp screens. */
  size: number;
  fallback: ReactNode;
  className?: string;
  width: number;
  height: number;
  eager?: boolean;
  preview?: boolean;
}) {
  const sources = tokenImageSources(url, size, mint);
  const key = `${url ?? ""}|${mint ?? ""}|${size}`;
  // Keyed by the image, so a card that gets its image later starts again from the first source.
  const [state, setState] = useState<{ key: string; attempt: number; loaded: boolean }>({
    key: "",
    attempt: 0,
    loaded: false,
  });
  const current = state.key === key ? state : { key, attempt: settled.get(key) ?? 0, loaded: false };
  const { attempt, loaded } = current;
  const src = sources[attempt];
  const ref = useRef<HTMLImageElement>(null);
  const big = useImagePreview(preview && url?.startsWith("https://") ? url : null, src ?? null);

  const next = () => {
    big.close();
    if (attempt + 1 >= sources.length) remember(key, sources.length);
    setState({ key, attempt: attempt + 1, loaded: false });
  };

  // Move on from a source that is on screen but has not answered in STALL_MS. Off screen, a lazy
  // image has not been asked for yet, so the clock starts when it scrolls into view.
  const hasNext = attempt + 1 < sources.length;
  useEffect(() => {
    const img = ref.current;
    if (!img || loaded || !hasNext || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver((entries) => {
      if (timer || !entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      timer = setTimeout(() => {
        if (!(img.complete && img.naturalWidth > 0)) next();
      }, STALL_MS);
    });
    io.observe(img);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
    // next() only reads values these already cover.
  }, [src, loaded, hasNext]);

  if (!src) return <>{fallback}</>;
  return (
    <>
      <img
        ref={ref}
        className={className}
        data-loading={loaded ? undefined : ""}
        src={src}
        alt=""
        width={width}
        height={height}
        loading={eager ? undefined : "lazy"}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => {
          remember(key, attempt);
          setState({ key, attempt, loaded: true });
        }}
        onError={next}
        {...(preview ? big.bind : {})}
      />
      {big.node}
    </>
  );
}
