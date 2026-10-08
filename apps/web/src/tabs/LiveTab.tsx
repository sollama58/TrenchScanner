import { useCallback, useMemo, useState } from "react";
import { type CuratedStats, type FeedStats, type Leaderboard, type MatchPage } from "../api";
import { AlertCard } from "../components/AlertCard";
import { SkeletonCards } from "../components/Charts";
import { ModelPicker, saveFeedSettings } from "../components/ModelPicker";
import { AboutModal } from "../components/AboutModal";
import { introSeen, markIntroSeen } from "../intro";
import { FeedStatsModal } from "../components/FeedStatsModal";
import { LighthouseButton } from "../components/MarketLighthouse";
import { ArrowRightIcon, BrainIcon, ChartIcon, InfoIcon, PaletteIcon, RadarIcon } from "../components/Icons";
import { prefetch } from "../cache";
import { useLiveMarketCaps, usePolling, useNow, useNudgeStream } from "../hooks";
import { ago, pct } from "../format";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";
import { CustomizeDrawer } from "../components/CustomizeDrawer";

/** Graded alerts below which the Stats button doesn't show a 2x rate (too early to mean much). */
const MIN_TEASER = 10;

/** The window the feed stats cover. */
const STATS_HOURS = 24;

/** The main tab: your own filter's catches and the model calls you follow, in one stream. */
export function LiveTab({
  goTo,
  walletAddress,
}: {
  goTo: (tab: "model" | "filters" | "settings") => void;
  walletAddress: string;
}) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  // Bumped when the user changes their feed settings, so every view keyed on them refetches at once.
  const [pick, setPick] = useState(0);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  // The tour opens by itself the first time this wallet lands here.
  const [aboutOpen, setAboutOpen] = useState(() => !introSeen(walletAddress));
  const closeAbout = () => {
    setAboutOpen(false);
    markIntroSeen(walletAddress);
  };
  const [statsOpen, setStatsOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const closeCustomize = useCallback(() => setCustomizing(false), []);
  const look = useAppearance();
  const hidden = useMemo(() => cardHideSet(look), [look]);
  // "saved": the API mixes in model calls per this user's own switch and checked models.
  const feedPath = (n: number) => `/matches?page=${n}&includeCurated=saved`;
  const feedPage = usePolling<MatchPage>(feedPath(page), 30_000, String(pick));
  const stats = usePolling<CuratedStats>("/curated/stats", 60_000);
  // The stats follow the same feed settings as the cards, so they refetch with them.
  const feedStats = usePolling<FeedStats>(`/matches/stats?hours=${STATS_HOURS}`, 30_000, String(pick));
  const fs = feedStats.data;
  const hours = fs?.hours ?? STATS_HOURS;
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000, String(pick));
  const lb = board.data;
  const modelsOn = lb?.showModelAlerts ?? true;
  // A new alert changes the stats as well as the cards, so both refetch on a nudge.
  const nudged = () => {
    feedPage.reload();
    feedStats.reload();
  };
  const curatedLive = useNudgeStream("/curated/stream", nudged, modelsOn);
  const matchesLive = useNudgeStream("/matches/stream", nudged);
  // "Now" on each card, seconds old rather than as old as the last feed poll.
  const cards = useLiveMarketCaps(feedPage.data?.matches);

  const t = lb?.targets ?? { hitRate2xPct: 75, hitRate4xPct: 50 };
  const chosen = lb ? lb.entries.filter((e) => lb.selectedModels.includes(e.id)) : [];
  // Older API builds (mid-deploy) only send totalCount.
  const hasMore = feedPage.data
    ? (feedPage.data.hasMore ?? page * feedPage.data.pageSize < feedPage.data.totalCount)
    : false;
  const chosenNames =
    chosen.length === 0
      ? "–"
      : chosen.length <= 2
        ? chosen.map((e) => e.name).join(" + ")
        : `${chosen[0]!.name} +${chosen.length - 1}`;
  const streamLive = matchesLive && (!modelsOn || curatedLive);

  const changed = () => {
    setPage(1);
    setPick((n) => n + 1);
  };
  const toggleModels = async () => {
    setToggling(true);
    setToggleError(null);
    try {
      await saveFeedSettings({ showModelAlerts: !modelsOn });
      changed();
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="stack">
      <FeedStatsModal
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        stats={fs ?? null}
        hours={hours}
        targets={t}
        pollKey={String(pick)}
      />
      <CustomizeDrawer open={customizing} onClose={closeCustomize} />
      <AboutModal open={aboutOpen} onClose={closeAbout} targets={t} />
      <section className="panel feed">
        <header className="section-head">
          <div>
            <span className="eyebrow">Live feed</span>
            <div className="heading-row">
              <h2>Your alerts{modelsOn ? " and model calls" : ""}</h2>
              <button
                type="button"
                className="ghost icon-btn"
                onClick={() => setAboutOpen(true)}
                aria-label="How this works"
                title="How this works"
              >
                <InfoIcon size={16} />
              </button>
            </div>
          </div>
          <div className="feed-controls">
            <button
              type="button"
              className="ghost stats-btn"
              onClick={() => setStatsOpen(true)}
              title={`Your feed's hit rates and best run over the last ${hours} hours`}
            >
              <ChartIcon size={14} />
              Stats
              {fs && fs.graded >= MIN_TEASER && fs.hit2xPct !== null && (
                <span className="num stats-teaser">2x {pct(fs.hit2xPct, 0)}</span>
              )}
            </button>
            <LighthouseButton base="/curated" />
            <button
              type="button"
              className={`ghost stats-btn${customizing ? " on" : ""}`}
              aria-expanded={customizing}
              onClick={() => setCustomizing((o) => !o)}
              title="Colors, spacing, columns and what each card shows, changed right here on your feed"
            >
              <PaletteIcon size={14} />
              Customize
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={modelsOn}
              className={`switch${modelsOn ? " on" : ""}`}
              disabled={!lb || toggling || board.stale}
              onClick={() => void toggleModels()}
            >
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
              Model alerts
            </button>
            {lb && <ModelPicker board={lb} disabled={!modelsOn} onChanged={changed} />}
            <span className={`live-dot ${streamLive ? "on" : ""}`}>{streamLive ? "Live" : "Polling"}</span>
            {toggleError && <small className="error">Couldn&apos;t switch model alerts: {toggleError}</small>}
          </div>
        </header>
        {feedPage.error && !feedPage.data && (
          <p className="error">Couldn&apos;t load your feed: {feedPage.error.message}</p>
        )}
        {!feedPage.data && !feedPage.error && <SkeletonCards count={4} />}
        {feedPage.data && feedPage.data.matches.length === 0 && page === 1 && (
          <div className="empty-state">
            <RadarIcon size={28} />
            <p>
              {modelsOn
                ? `Nothing yet from your filter or ${chosenNames}. Alerts land here the moment one comes in.`
                : "Nothing caught by your filter yet. Turn on model alerts to see the models' calls here too."}
            </p>
            <button className="ghost" onClick={() => goTo("filters")}>
              Tune your filter <ArrowRightIcon size={13} />
            </button>
          </div>
        )}
        <div
          className={`cards${feedPage.stale ? " stale" : ""}`}
          aria-busy={feedPage.stale}
          {...feedGridProps(look)}
        >
          {cards?.map((card) => (
            <AlertCard key={card.id} card={card} now={now} labelSource hide={hidden} />
          ))}
        </div>
        {feedPage.data && feedPage.data.matches.length === 0 && page > 1 && (
          <p className="muted small center">Nothing older here.</p>
        )}
        {(page > 1 || hasMore) && (
          <nav className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Newer
            </button>
            <span className="muted small num">Page {page}</span>
            <button
              disabled={!hasMore || feedPage.stale}
              // Start the next page on hover/focus so the click usually finds it already here.
              onPointerEnter={() => prefetch(feedPath(page + 1))}
              onFocus={() => prefetch(feedPath(page + 1))}
              onClick={() => setPage((p) => p + 1)}
            >
              Older →
            </button>
          </nav>
        )}
        {stats.data && look.learningNote && (
          <div className="learning-note">
            <BrainIcon size={14} />
            <span>
              Learning from{" "}
              <strong className="num">{stats.data.training.finalizedSamples.toLocaleString()}</strong> graded
              moments. Base 2x rate {pct(stats.data.training.baseWinRatePct, 1)}
              {stats.data.curator.modelTrainedAt &&
                `, model data to ${ago(stats.data.curator.modelTrainedAt, now)}`}
              .
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
