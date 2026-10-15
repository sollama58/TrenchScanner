import { useCallback, useMemo, useState } from "react";
import type { LaunchPage } from "../api";
import { STREAM_DATA } from "../routes";
import { useLiveMarketCaps, useNow, usePolling } from "../hooks";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";
import { prefetch } from "../cache";
import { cardMatchesCa, parseCaQuery } from "../caSearch";
import { AlertCard } from "./AlertCard";
import { CaSearchBox, CaSearchNote, CaSearchResults } from "./CaSearch";
import { SkeletonCards } from "./Charts";
import { CustomizeDrawer } from "./CustomizeDrawer";
import { PaletteIcon, RadarIcon } from "./Icons";

/** How often the Stream asks for new arrivals. The scan writes a cycle's verdicts about a minute apart. */
const STREAM_POLL_MS = 10_000;

/** Older pages move only as new tokens push them along, so they are asked for less often. */
const STREAM_OLDER_POLL_MS = 30_000;

/** The Stream's page `n`: the first is the bare path, which the boot prefetch has already asked for. */
const streamPath = (n: number) => (n === 1 ? STREAM_DATA : `${STREAM_DATA}?page=${n}`);

/**
 * The Stream tab: every new token the moment it has passed the safety screen inside the band,
 * newest first, drawn with the Live feed's cards and the reader's own card settings, a page at a
 * time with older pages behind it. Hidden until the reader switches it on in Settings
 * (FeedAppearance.streamTab).
 */
export function StreamView() {
  const now = useNow(5_000);
  const look = useAppearance();
  const hidden = useMemo(() => cardHideSet(look), [look]);
  const [pageNo, setPageNo] = useState(1);
  const page = usePolling<LaunchPage>(
    streamPath(pageNo),
    pageNo === 1 ? STREAM_POLL_MS : STREAM_OLDER_POLL_MS,
  );
  // The CA search: a whole address is looked up across the Stream; part of one narrows this page.
  const [caInput, setCaInput] = useState("");
  const clearCa = useCallback(() => setCaInput(""), []);
  const ca = parseCaQuery(caInput);
  const caPartial = ca.kind === "partial" ? ca.text : null;
  const launches = page.data?.launches;
  const pageCards = useMemo(
    () => (caPartial && launches ? launches.filter((c) => cardMatchesCa(c, caPartial)) : launches),
    [launches, caPartial],
  );
  // "Now" on each card, seconds old, from the same tick the Live feed uses. A whole-address search
  // ticks its own card, so this one rests meanwhile.
  const cards = useLiveMarketCaps(ca.kind === "full" ? undefined : pageCards);
  const [customizing, setCustomizing] = useState(false);
  const closeCustomize = useCallback(() => setCustomizing(false), []);
  const live = page.data != null && !page.error;
  const hasMore = page.data?.hasMore ?? false;

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
            <CaSearchBox
              value={caInput}
              onChange={setCaInput}
              title="Find a token on the Stream by its contract address. Press / to jump here."
            />
            <span className={`live-dot ${live ? "on" : ""}`}>{live ? "Live" : "Connecting"}</span>
          </div>
        </header>
        {ca.kind === "full" ? (
          <CaSearchResults<LaunchPage>
            path={`${STREAM_DATA}?mint=${ca.mint}`}
            pollMs={STREAM_POLL_MS}
            cardsOf={(d) => d.launches}
            mint={ca.mint}
            where="the Stream"
            onClear={clearCa}
            now={now}
            hide={hidden}
            look={look}
          />
        ) : (
          <>
            {caPartial && (
              <CaSearchNote
                found={cards ? cards.length : null}
                mint={null}
                partial={caPartial}
                where="the Stream"
                onClear={clearCa}
              />
            )}
            {page.error && !page.data && (
              <p className="error">Couldn&apos;t load the Stream: {page.error.message}</p>
            )}
            {!page.data && !page.error && <SkeletonCards count={4} />}
            {!caPartial && page.data && page.data.launches.length === 0 && (
              <div className="empty-state">
                <RadarIcon size={28} />
                <p>
                  {pageNo === 1
                    ? "Nothing has passed the safety screen in the band in the last day. New tokens land here the moment one does."
                    : "Nothing older on the Stream from the last day."}
                </p>
              </div>
            )}
            <div
              className={`cards stream-cards${page.stale ? " stale" : ""}`}
              aria-busy={page.stale}
              {...feedGridProps(look)}
            >
              {cards?.map((card) => (
                <AlertCard key={card.id} card={card} now={now} hide={hidden} />
              ))}
            </div>
            {(pageNo > 1 || hasMore) && (
              <nav className="pager">
                <button disabled={pageNo <= 1} onClick={() => setPageNo((p) => p - 1)}>
                  ← Newer
                </button>
                <span className="muted small num">Page {pageNo}</span>
                <button
                  disabled={!hasMore || page.stale}
                  // Start the next page on hover/focus so the click usually finds it already here.
                  onPointerEnter={() => prefetch(streamPath(pageNo + 1))}
                  onFocus={() => prefetch(streamPath(pageNo + 1))}
                  onClick={() => setPageNo((p) => p + 1)}
                >
                  Older →
                </button>
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  );
}
