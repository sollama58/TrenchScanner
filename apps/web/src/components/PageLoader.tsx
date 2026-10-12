import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { loadState, subscribeLoad } from "../loadTracker";
import { LogoMark } from "./Icons";

/** A load quicker than this shows nothing, so a fast tab switch doesn't flash the loader. */
const SHOW_AFTER_MS = 150;
/** A page load still going after this stops hiding the page: whatever has landed shows, dimmed. */
const OVERLAY_MAX_MS = 12_000;
/** How long the bar sits at 100% before fading out. */
const FINISH_MS = 380;
const TICK_MS = 120;

/**
 * The loading bar along the top of the window, and while a page is loading (the app opening, a
 * tab switch, signing in) an overlay with the logo and a percentage over the content, so the
 * previous page or a blank screen never reads as the current one.
 *
 * The percentage follows the waits loadTracker.ts counts (each view's first answer, a tab's code),
 * and creeps toward 90% between them so a single slow request still shows movement; it reaches
 * 100% only when everything has landed.
 */
export function PageLoader({ label }: { label: string }) {
  const load = useSyncExternalStore(subscribeLoad, loadState);
  const [phase, setPhase] = useState<"idle" | "showing" | "finishing">("idle");
  const [progress, setProgress] = useState(0);
  const [overlayExpired, setOverlayExpired] = useState(false);
  const creep = useRef(0);

  // Start showing once a load has run past SHOW_AFTER_MS; finish when it settles.
  useEffect(() => {
    if (load.active) {
      if (phase === "showing") return;
      const t = window.setTimeout(
        () => {
          creep.current = 0.08;
          setProgress(0.08);
          setOverlayExpired(false);
          setPhase("showing");
        },
        // The app's first load takes over from index.html's loader without a gap.
        phase === "finishing" || load.boot ? 0 : SHOW_AFTER_MS,
      );
      return () => window.clearTimeout(t);
    }
    if (phase !== "showing") return;
    setProgress(1);
    setPhase("finishing");
  }, [load.active, load.boot, phase]);

  useEffect(() => {
    if (phase !== "finishing") return;
    const t = window.setTimeout(() => setPhase("idle"), FINISH_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  // While showing: creep toward 90%, never below what the finished waits say, never backwards.
  useEffect(() => {
    if (phase !== "showing") return;
    const tick = () => {
      creep.current += (0.9 - creep.current) * 0.04;
      const real = load.total > 0 ? load.done / load.total : 0;
      const next = Math.min(0.95, Math.max(creep.current, 0.08 + 0.87 * real));
      setProgress((p) => Math.max(p, next));
      if (performance.now() - load.startedAt > OVERLAY_MAX_MS) setOverlayExpired(true);
    };
    tick();
    const t = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(t);
  }, [phase, load.done, load.total, load.startedAt]);

  const visible = phase !== "idle";
  const overlay = visible && load.page && !overlayExpired;

  // The content under the overlay is the previous page or a placeholder: dim it out of the way.
  useEffect(() => {
    const root = document.documentElement;
    if (overlay && phase === "showing") root.dataset.pageLoading = "page";
    else delete root.dataset.pageLoading;
    return () => {
      delete root.dataset.pageLoading;
    };
  }, [overlay, phase]);

  if (!visible) return null;
  const pct = Math.round(progress * 100);
  return (
    <>
      <div className={`page-bar${phase === "finishing" ? " done" : ""}`} aria-hidden>
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      {overlay && (
        <div className={`page-loader${load.boot ? " instant" : ""}${phase === "finishing" ? " done" : ""}`}>
          <div
            className="page-loader-card"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div className="page-loader-mark" aria-hidden>
              <span className="page-loader-sweep" />
              <LogoMark size={44} />
            </div>
            <div className="page-loader-label">{label}</div>
            <div className="page-loader-track" aria-hidden>
              <span style={{ transform: `scaleX(${progress})` }} />
            </div>
            <div className="page-loader-pct num" aria-hidden>
              {pct}%
            </div>
          </div>
        </div>
      )}
    </>
  );
}
