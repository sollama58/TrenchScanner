import { Suspense, useState } from "react";
import type { FeedStats, Leaderboard } from "../api";
import { usePolling } from "../hooks";
import { pct } from "../format";
import { FeedStatsModal, loadFeedStatsModal, useOpenedOnce } from "../livePanels";
import { ChartIcon } from "./Icons";

/** Graded alerts below which the button doesn't show a 2x rate (too early to mean much). */
const MIN_TEASER = 10;

/** The window the feed stats cover. */
const STATS_HOURS = 24;

/**
 * The feed's Stats button (hit rates and best run over the last day) and its window. It sat in the
 * Live feed's header until the user moved it to the Filters and Models tabs (user ask 2026-10-23),
 * where the people tuning what feeds the Live tab read how it is doing.
 */
export function FeedStatsButton() {
  const [open, setOpen] = useState(false);
  const mounted = useOpenedOnce(open);
  const feedStats = usePolling<FeedStats>(`/matches/stats?hours=${STATS_HOURS}`, 60_000);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000);
  const fs = feedStats.data;
  const hours = fs?.hours ?? STATS_HOURS;
  const targets = board.data?.targets ?? { hitRate2xPct: 75, hitRate4xPct: 50 };
  return (
    <>
      <Suspense fallback={null}>
        {mounted && (
          <FeedStatsModal
            open={open}
            onClose={() => setOpen(false)}
            stats={fs ?? null}
            hours={hours}
            targets={targets}
            pollKey=""
          />
        )}
      </Suspense>
      <button
        type="button"
        className="ghost stats-btn"
        onClick={() => setOpen(true)}
        onPointerEnter={() => void loadFeedStatsModal()}
        onFocus={() => void loadFeedStatsModal()}
        title={`Your Live feed's hit rates and best run over the last ${hours} hours`}
      >
        <ChartIcon size={14} />
        Feed stats
        {fs && fs.graded >= MIN_TEASER && fs.hit2xPct !== null && (
          <span className={`num stats-teaser${feedStats.stale ? " stale" : ""}`}>
            2x {pct(fs.hit2xPct, 0)}
          </span>
        )}
      </button>
    </>
  );
}
