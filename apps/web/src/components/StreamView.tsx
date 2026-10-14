import { useCallback, useMemo, useState } from "react";
import type { LaunchPage } from "../api";
import { STREAM_DATA } from "../routes";
import { useLiveMarketCaps, useNow, usePolling } from "../hooks";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";
import { AlertCard } from "./AlertCard";
import { SkeletonCards } from "./Charts";
import { CustomizeDrawer } from "./CustomizeDrawer";
import { PaletteIcon, RadarIcon } from "./Icons";

/** How often the Stream asks for new arrivals. The scan writes a cycle's verdicts about a minute apart. */
const STREAM_POLL_MS = 10_000;

/**
 * The Stream tab: every new token the moment it has passed the safety screen inside the band,
 * newest first, drawn with the Live feed's cards and the reader's own card settings. Hidden until
 * the reader switches it on in Settings (FeedAppearance.streamTab).
 */
export function StreamView() {
  const now = useNow(5_000);
  const look = useAppearance();
  const hidden = useMemo(() => cardHideSet(look), [look]);
  const page = usePolling<LaunchPage>(STREAM_DATA, STREAM_POLL_MS);
  // "Now" on each card, seconds old, from the same tick the Live feed uses.
  const cards = useLiveMarketCaps(page.data?.launches);
  const [customizing, setCustomizing] = useState(false);
  const closeCustomize = useCallback(() => setCustomizing(false), []);
  const live = page.data != null && !page.error;

  return (
    <div className="stack">
      <CustomizeDrawer open={customizing} onClose={closeCustomize} />
      <section className="panel feed">
        <header className="section-head">
          <div>
            <span className="eyebrow">Stream</span>
            <h2>New tokens that passed the safety screen in the band</h2>
          </div>
          <div className="feed-controls">
            <button
              type="button"
              className={`ghost stats-btn${customizing ? " on" : ""}`}
              aria-expanded={customizing}
              onClick={() => setCustomizing((o) => !o)}
              title="Colors, spacing, columns and what each card shows - the same settings as your Live feed"
            >
              <PaletteIcon size={14} />
              Customize
            </button>
            <span className={`live-dot ${live ? "on" : ""}`}>{live ? "Live" : "Connecting"}</span>
          </div>
        </header>
        {page.error && !page.data && (
          <p className="error">Couldn&apos;t load the Stream: {page.error.message}</p>
        )}
        {!page.data && !page.error && <SkeletonCards count={4} />}
        {page.data && page.data.launches.length === 0 && (
          <div className="empty-state">
            <RadarIcon size={28} />
            <p>
              Nothing has passed the safety screen in the band in the last day. New tokens land here the
              moment one does.
            </p>
          </div>
        )}
        <div className={`cards stream-cards${page.stale ? " stale" : ""}`} {...feedGridProps(look)}>
          {cards?.map((card) => (
            <AlertCard key={card.id} card={card} now={now} hide={hidden} />
          ))}
        </div>
      </section>
    </div>
  );
}
