import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { tokenThumb } from "../format";

/** The desktop hover preview is this many times the image's size, kept inside the window. */
const PREVIEW_SCALE = 6;
const PREVIEW_GAP = 12;
const EDGE = 8;
/** A preview smaller than this isn't worth drawing (a window too small to hold it). */
const PREVIEW_MIN = 80;
/** Only a real mouse/trackpad gets the preview; touch screens fire hover on tap. */
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

type PreviewSpot = { left: number; top: number; size: number };

/** Where the preview goes: beside the image (right, else left), clamped to the window. */
function previewSpot(rect: DOMRect): PreviewSpot {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const size = Math.max(0, Math.min(rect.width * PREVIEW_SCALE, vw - 2 * EDGE, vh - 2 * EDGE));
  let left = rect.right + PREVIEW_GAP;
  if (left + size > vw - EDGE) left = rect.left - PREVIEW_GAP - size;
  left = Math.min(Math.max(EDGE, left), vw - EDGE - size);
  const top = Math.min(Math.max(EDGE, rect.top + rect.height / 2 - size / 2), vh - EDGE - size);
  return { left, top, size };
}

/**
 * A token image's large hover preview on desktop (the alert card's avatar, Scope's rows): spread
 * `bind` on the image, render `node`. `original` is the launcher's https URL; `small` the
 * thumbnail already on screen, shown at once until the sharp one arrives.
 */
export function useImagePreview(original: string | null, small: string | null) {
  const [spot, setSpot] = useState<PreviewSpot | null>(null);

  // A scroll or resize moves the image out from under the preview; close it rather than chase it.
  useEffect(() => {
    if (!spot) return;
    const close = () => setSpot(null);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [spot]);

  const bind = {
    onPointerEnter: (e: React.PointerEvent<Element>) => {
      if (e.pointerType !== "mouse" || !window.matchMedia?.(HOVER_QUERY).matches) return;
      const s = previewSpot(e.currentTarget.getBoundingClientRect());
      setSpot(s.size >= PREVIEW_MIN ? s : null);
    },
    onPointerLeave: () => setSpot(null),
  };
  const node =
    spot && original && small
      ? createPortal(
          <ImagePreview spot={spot} small={small} large={tokenThumb(original, 512)} original={original} />,
          document.body,
        )
      : null;
  return { bind, node, close: () => setSpot(null) };
}

/**
 * The hover preview, outside the card (whose overflow and hover transform would clip or shift a
 * fixed child). The small thumbnail already loaded shows at once, and the sharp image covers it
 * when it arrives; if that fails, the original URL, else the small one stays.
 */
function ImagePreview({
  spot,
  small,
  large,
  original,
}: {
  spot: PreviewSpot;
  small: string;
  large: string;
  original: string;
}) {
  const [sharp, setSharp] = useState<string | null>(large);
  const [ready, setReady] = useState(false);
  return (
    <div
      className="avatar-preview"
      aria-hidden="true"
      style={{ left: spot.left, top: spot.top, width: spot.size, height: spot.size }}
    >
      <img src={small} alt="" referrerPolicy="no-referrer" />
      {sharp && (
        <img
          className={ready ? "ready" : undefined}
          src={sharp}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setReady(true)}
          onError={() => setSharp(sharp !== original && sharp === large ? original : null)}
        />
      )}
    </div>
  );
}
