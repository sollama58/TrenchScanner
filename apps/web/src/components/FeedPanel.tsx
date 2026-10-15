import { useState } from "react";
import type { FeedStats, Leaderboard } from "../api";
import { RingGauge, Skeleton } from "./Charts";
import { FeedReturns } from "./FeedReturns";
import { BoltIcon, ChartIcon, RadarIcon, TrophyIcon } from "./Icons";
import { saveFeedSettings } from "./ModelPicker";
import { usePolling } from "../hooks";
import { multiple, pct } from "../format";

/** Graded alerts below which a hit rate shows as "early" rather than as a verdict. */
const MIN_GRADED = 10;

/** The window the feed stats cover. */
const STATS_HOURS = 24;

/**
 * Settings › Your feed: the Model alerts switch (whether the models' calls join your filter's
 * alerts on the Live feed) and the feed's numbers over the last day - what the Live tab's Stats
 * button and switch used to show (user decision 2026-10-15). Which models' calls you get is
 * picked with the switches on the Models tab.
 */
export function FeedPanel({ goTo }: { goTo: (tab: "model") => void }) {
  // Bumped when the switch changes, so the board, the stats and the returns refetch at once.
  const [pick, setPick] = useState(0);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000, String(pick));
  const stats = usePolling<FeedStats>(`/matches/stats?hours=${STATS_HOURS}`, 30_000, String(pick));
  const lb = board.data;
  const fs = stats.data;
  const hours = fs?.hours ?? STATS_HOURS;
  const t = lb?.targets ?? { hitRate2xPct: 75, hitRate4xPct: 50 };
  const modelsOn = lb?.showModelAlerts ?? true;
  const chosen = lb ? lb.entries.filter((e) => lb.selectedModels.includes(e.id)).map((e) => e.name) : [];

  const toggleModels = async () => {
    setToggling(true);
    setError(null);
    try {
      await saveFeedSettings({ showModelAlerts: !modelsOn });
      setPick((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  };

  return (
    <section className="panel feed-panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <ChartIcon size={13} /> Your feed
          </span>
          <h2>Live feed and its stats</h2>
        </div>
      </header>
      <div className="tab-option">
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
        <p className="muted small">
          {modelsOn ? (
            <>
              The models&apos; calls ({chosen.join(", ") || "–"}) show on your Live feed beside your
              filter&apos;s alerts.{" "}
            </>
          ) : (
            <>Only your filter&apos;s alerts show on your Live feed. </>
          )}
          Pick which models with the switches on the{" "}
          <button type="button" className="link" onClick={() => goTo("model")}>
            Models tab
          </button>
          .
        </p>
        {error && <small className="error">Couldn&apos;t switch model alerts: {error}</small>}
      </div>
      <h3 className="feed-stats-title">Last {hours} hours</h3>
      {!fs ? (
        !stats.error && <Skeleton lines={4} />
      ) : (
        <div className={stats.stale ? "stale" : ""}>
          <section className="kpis stats-grid">
            <div className="panel kpi stats-wide">
              <span className="eyebrow">
                <RadarIcon size={13} /> Alerts · {hours}h
              </span>
              <span className="kpi-value num">{fs?.alerts ?? "–"}</span>
              <small className="muted">
                {fs
                  ? fs.alerts === 0
                    ? "No alerts yet"
                    : `${fs.fromFilter} from your filter${fs.showModelAlerts ? `, ${fs.fromModels} model calls` : ""}`
                  : "Loading…"}
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
          <p className="faint small stats-note">
            Coins alerted in your feed over the last {hours} hours, graded from the alert price. Alerts still
            being graded don&apos;t count as misses.
          </p>
          <FeedReturns pollKey={String(pick)} />
        </div>
      )}
      {stats.error && !fs && (
        <p className="error small">Couldn&apos;t load your feed stats: {stats.error.message}</p>
      )}
    </section>
  );
}
