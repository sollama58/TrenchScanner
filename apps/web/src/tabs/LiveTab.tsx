import { useState } from "react";
import {
  type CuratedStats,
  type FeedStats,
  type Leaderboard,
  type MarketWeather,
  type MatchPage,
} from "../api";
import { AlertCard } from "../components/AlertCard";
import { RingGauge, SkeletonCards } from "../components/Charts";
import { ModelPicker, saveFeedSettings } from "../components/ModelPicker";
import { AboutModal } from "../components/AboutModal";
import { ArrowRightIcon, BoltIcon, BrainIcon, InfoIcon, RadarIcon, TrophyIcon } from "../components/Icons";
import { prefetch } from "../cache";
import { useLiveMarketCaps, usePolling, useNow, useNudgeStream } from "../hooks";
import { ago, multiple, pct } from "../format";

/** Graded alerts below which a hit rate shows as "early" rather than as a verdict. */
const MIN_GRADED = 10;

/** The window the top tiles cover. */
const STATS_HOURS = 24;

/** The main tab: your own filter's catches and the model calls you follow, in one stream. */
export function LiveTab({ goTo }: { goTo: (tab: "model" | "filters") => void }) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  // Bumped when the user changes their feed settings, so every view keyed on them refetches at once.
  const [pick, setPick] = useState(0);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  // "saved": the API mixes in model calls per this user's own switch and checked models.
  const feedPath = (n: number) => `/matches?page=${n}&includeCurated=saved`;
  const feedPage = usePolling<MatchPage>(feedPath(page), 30_000, String(pick));
  const stats = usePolling<CuratedStats>("/curated/stats", 60_000);
  // The tiles follow the same feed settings as the cards, so they refetch with them.
  const feedStats = usePolling<FeedStats>(`/matches/stats?hours=${STATS_HOURS}`, 30_000, String(pick));
  const fs = feedStats.data;
  const hours = fs?.hours ?? STATS_HOURS;
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000, String(pick));
  const lb = board.data;
  const modelsOn = lb?.showModelAlerts ?? true;
  // A new alert changes the tiles as well as the cards, so both refetch on a nudge.
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
      <section className="kpis kpis-five">
        <div className="panel kpi">
          <span className="eyebrow">
            <RadarIcon size={13} /> Your feed · {hours}h
          </span>
          <span className="kpi-value num">{fs?.alerts ?? "–"}</span>
          <small className="muted">
            {fs
              ? fs.alerts === 0
                ? "No alerts yet"
                : `${fs.fromFilter} from your filter${fs.showModelAlerts ? `, ${fs.fromModels} model calls` : ""}`
              : " "}
          </small>
          {fs && fs.pending > 0 && <small className="faint">{fs.pending} still grading</small>}
        </div>
        <div className="panel kpi kpi-ring">
          <RingGauge
            label="Hit 2x within 15 min"
            value={fs?.hit2xPct ?? null}
            target={t.hitRate2xPct}
            graded={fs?.graded ?? 0}
            minGraded={MIN_GRADED}
            series={1}
          />
        </div>
        <div className="panel kpi kpi-ring">
          <RingGauge
            label="Hit 4x within 30 min"
            value={fs?.hit4xPct ?? null}
            target={t.hitRate4xPct}
            graded={fs?.goalGraded ?? 0}
            minGraded={MIN_GRADED}
            series={2}
          />
        </div>
        <div className="panel kpi">
          <span className="eyebrow">
            <TrophyIcon size={13} /> Hit 10x within 1 hr
          </span>
          <span className="kpi-value num">{fs?.hit10xPct != null ? pct(fs.hit10xPct, 1) : "–"}</span>
          <small className="muted">
            {fs?.tenXGraded
              ? `${fs.hit10x ?? 0} of ${fs.tenXGraded} settled alerts`
              : "No settled alerts yet"}
          </small>
        </div>
        <div className="panel kpi">
          <span className="eyebrow">
            <BoltIcon size={13} /> Best run · {hours}h
          </span>
          <span className="kpi-value num">{fs?.best ? multiple(fs.best.peakPct) : "–"}</span>
          <small className="muted">
            {fs?.best ? (fs.best.symbol ? `$${fs.best.symbol}` : "unnamed token") : " "}
          </small>
          {fs?.medianPeakPct != null && (
            <small className="faint">Typical alert peaked at {multiple(fs.medianPeakPct)}</small>
          )}
        </div>
      </section>
      <div className="window-row">
        <p className="window-note faint small">
          Coins alerted in your feed over the last {hours} hours, graded from the alert price. Alerts still
          being graded don&apos;t count as misses.
        </p>
        {stats.data?.market && <WeatherChip weather={stats.data.market} onAbout={() => setAboutOpen(true)} />}
      </div>

      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} targets={t} />
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
        <div className={`cards${feedPage.stale ? " stale" : ""}`} aria-busy={feedPage.stale}>
          {cards?.map((card) => (
            <AlertCard key={card.id} card={card} now={now} labelSource />
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
        {stats.data && (
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

const WEATHER_LABEL: Record<MarketWeather["condition"], string> = {
  hot: "Hot market",
  normal: "Normal market",
  cold: "Cold market",
  unknown: "Market: too early to read",
};

/**
 * How often launches are doubling right now against the last week. Informational only: it holds
 * nothing back. The hover says what it measured; a click opens the full explanation.
 */
function WeatherChip({ weather: w, onAbout }: { weather: MarketWeather; onAbout: () => void }) {
  const detail =
    w.recentRatePct === null
      ? `Only ${w.recentGraded} graded moments in the last ${w.recentHours}h, too few to read.`
      : `${pct(w.recentRatePct, 1)} of ${w.recentGraded.toLocaleString()} launch moments doubled within 15 minutes ` +
        `over the last ${w.recentHours}h` +
        (w.trailingRatePct === null
          ? `. Not enough history yet for the ${w.trailingDays}-day average.`
          : `, against ${pct(w.trailingRatePct, 1)} over the last ${w.trailingDays} days.`);
  const title = `${detail} Informational only: it doesn't change or hold back any alert. Click for how it works.`;
  return (
    <button
      type="button"
      className={`weather-chip ${w.condition}`}
      onClick={onAbout}
      title={title}
      aria-label={`${WEATHER_LABEL[w.condition]}. ${title}`}
    >
      <span className="weather-dot" aria-hidden="true" />
      {WEATHER_LABEL[w.condition]}
      {w.recentRatePct !== null && (
        <span className="num">
          {" "}
          · {pct(w.recentRatePct, 0)} doubling ({w.recentHours}h)
          {w.trailingRatePct !== null && ` vs ${pct(w.trailingRatePct, 0)} (${w.trailingDays}d)`}
        </span>
      )}
    </button>
  );
}
