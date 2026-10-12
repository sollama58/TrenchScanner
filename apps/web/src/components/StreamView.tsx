import { useCallback, useMemo, useState } from "react";
import type { LaunchPage } from "../api";
import { STREAM_DATA } from "../routes";
import { useLiveMarketCaps, useNow, usePolling } from "../hooks";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";
import { AlertCard } from "./AlertCard";
import { SkeletonCards } from "./Charts";
import { CustomizeDrawer } from "./CustomizeDrawer";
import { LogoMark, PaletteIcon, PopOutIcon, RadarIcon, StreamIcon } from "./Icons";

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
 * first, drawn with the Live feed's cards and the reader's own card settings. A focus mode: the
 * header and tabs give way to one slim bar holding the switch back.
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
            <button
              type="button"
              className="ghost stats-btn stream-popout"
              onClick={popOutStream}
              title="Open the Stream in its own window"
            >
              <PopOutIcon size={14} />
              <span className="stream-btn-label">Pop out</span>
            </button>
          )}
          <StreamSwitch on onToggle={onExit} label />
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

/** The Stream's on/off switch: in the header to go in, on the Stream's own bar to come back out. */
export function StreamSwitch({
  on,
  onToggle,
  label = false,
}: {
  on: boolean;
  onToggle: () => void;
  label?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Stream"
      className={`switch stream-switch${on ? " on" : ""}`}
      onClick={onToggle}
      title={on ? "Back to the dashboard" : "Only the Stream of new tokens, full screen"}
    >
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      <StreamIcon size={15} className="stream-switch-icon" />
      {label && <span className="stream-switch-label">Stream</span>}
    </button>
  );
}
