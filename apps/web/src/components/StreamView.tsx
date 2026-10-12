import { useCallback, useMemo, useState } from "react";
import type { LaunchPage } from "../api";
import { STREAM_DATA } from "../routes";
import { useLiveMarketCaps, useNow, usePolling } from "../hooks";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";
import { AlertCard } from "./AlertCard";
import { SkeletonCards } from "./Charts";
import { CustomizeDrawer } from "./CustomizeDrawer";
import { ArrowRightIcon, LogoMark, PaletteIcon, PopOutIcon, RadarIcon } from "./Icons";

/** How often the Stream asks for new arrivals. The scan writes a cycle's verdicts about a minute apart. */
const STREAM_POLL_MS = 10_000;

/** The pop-out's window name: opening it again reuses the window rather than stacking another. */
export const STREAM_WINDOW = "trenchscanner-stream";

/** Whether this window is the Stream's pop-out. */
export const inStreamWindow = () => window.name === STREAM_WINDOW;

/** Opens the Stream in a window of its own (a tab where the browser won't make a popup). */
export function popOutStream() {
  const url = `${window.location.origin}${window.location.pathname}#stream`;
  const w = window.open(url, STREAM_WINDOW, "popup,width=1180,height=860");
  w?.focus();
}

/**
 * The Stream: every new token the moment it has passed the safety screen inside the band, newest
 * first, drawn with the Live feed's cards and the reader's own card settings. It opens in a window
 * of its own (the header's Stream button), where the header and tabs give way to one slim bar.
 * Opened in an ordinary tab instead (a browser that won't make popups, or a #stream link), the bar
 * also offers the way back to the dashboard.
 */
export function StreamView({ onExit }: { onExit: () => void }) {
  const now = useNow(5_000);
  const look = useAppearance();
  const hidden = useMemo(() => cardHideSet(look), [look]);
  const page = usePolling<LaunchPage>(STREAM_DATA, STREAM_POLL_MS);
  // "Now" on each card, seconds old, from the same tick the Live feed uses.
  const cards = useLiveMarketCaps(page.data?.launches);
  const [customizing, setCustomizing] = useState(false);
  const closeCustomize = useCallback(() => setCustomizing(false), []);
  const popup = inStreamWindow();

  return (
    <div className="stream">
      <div className="stream-bar">
        <span className="stream-title">
          <LogoMark size={22} />
          <strong>Stream</strong>
          <span className="stream-sub muted small">New tokens that passed the safety screen in the band</span>
        </span>
        <span className="stream-actions">
          <span className={`live-dot ${page.data && !page.error ? "on" : ""}`}>
            {page.data && !page.error ? "Live" : "Connecting"}
          </span>
          <button
            type="button"
            className={`ghost stats-btn${customizing ? " on" : ""}`}
            aria-expanded={customizing}
            onClick={() => setCustomizing((o) => !o)}
            title="Colors, spacing, columns and what each card shows - the same settings as your Live feed"
          >
            <PaletteIcon size={14} />
            <span className="stream-btn-label">Customize</span>
          </button>
          {!popup && (
            <button type="button" className="ghost stats-btn" onClick={onExit} title="Back to the dashboard">
              <span className="stream-btn-label">Dashboard</span>
              <ArrowRightIcon size={13} />
            </button>
          )}
        </span>
      </div>
      <CustomizeDrawer open={customizing} onClose={closeCustomize} />
      {page.error && !page.data && (
        <p className="error">Couldn&apos;t load the Stream: {page.error.message}</p>
      )}
      {!page.data && !page.error && <SkeletonCards count={8} />}
      {page.data && page.data.launches.length === 0 && (
        <div className="empty-state">
          <RadarIcon size={28} />
          <p>
            Nothing has passed the safety screen in the band in the last day. New tokens land here the moment
            one does.
          </p>
        </div>
      )}
      <div className={`cards stream-cards${page.stale ? " stale" : ""}`} {...feedGridProps(look)}>
        {cards?.map((card) => (
          <AlertCard key={card.id} card={card} now={now} hide={hidden} />
        ))}
      </div>
    </div>
  );
}

/** The header's way to the Stream: opens it in a window of its own. */
export function StreamButton() {
  return (
    <button
      type="button"
      className="ghost stats-btn stream-open"
      onClick={popOutStream}
      title="Open the Stream of new tokens in its own window"
    >
      <PopOutIcon size={14} />
      <span>Stream</span>
    </button>
  );
}
