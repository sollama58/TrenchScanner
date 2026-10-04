import { useState } from "react";
import { type CuratedStats, type Leaderboard, type MatchPage } from "../api";
import { AlertCard } from "../components/AlertCard";
import { RingGauge, SkeletonCards } from "../components/Charts";
import { ModelPicker, saveFeedSettings } from "../components/ModelPicker";
import { ArrowRightIcon, BrainIcon, RadarIcon, SlidersIcon } from "../components/Icons";
import { usePolling, useNow, useNudgeStream } from "../hooks";
import { ago, pct } from "../format";

/** Graded calls below which a hit rate shows as "early" rather than as a verdict. */
const MIN_GRADED = 30;

/** The main tab: your own filter's catches and the model calls you follow, in one stream. */
export function LiveTab({ goTo }: { goTo: (tab: "model" | "filters") => void }) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  // Bumped when the user changes their feed settings, so every view keyed on them refetches at once.
  const [pick, setPick] = useState(0);
  const [toggling, setToggling] = useState(false);
  // "saved": the API mixes in model calls per this user's own switch and checked models.
  const feedPage = usePolling<MatchPage>(`/matches?page=${page}&includeCurated=saved`, 30_000, String(pick));
  const stats = usePolling<CuratedStats>("/curated/stats", 60_000);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000, String(pick));
  const lb = board.data;
  const modelsOn = lb?.showModelAlerts ?? true;
  const curatedLive = useNudgeStream("/curated/stream", feedPage.reload, modelsOn);
  const matchesLive = useNudgeStream("/matches/stream", feedPage.reload);

  const t = lb?.targets ?? { hitRate2xPct: 75, hitRate4xPct: 50 };
  const chosen = lb ? lb.entries.filter((e) => lb.selectedModels.includes(e.id)) : [];
  // The rings follow the best-ranked model you follow.
  const selected = chosen[0] ?? null;
  const live = selected?.composite.live;
  const feed = stats.data?.feed;
  const pace = feed ? Math.min(100, (feed.pace.actualPerHour24h / feed.pace.targetPerHour) * 100) : 0;
  const pages = feedPage.data ? Math.max(1, Math.ceil(feedPage.data.totalCount / feedPage.data.pageSize)) : 1;
  const modelName = selected?.name ?? "–";
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
    try {
      await saveFeedSettings({ showModelAlerts: !modelsOn });
      changed();
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="stack">
      <section className="kpis">
        <div className="panel kpi kpi-ring">
          <RingGauge
            label={`${modelName} calls that hit 2x`}
            value={live?.winRatePct ?? null}
            target={t.hitRate2xPct}
            graded={live?.graded ?? 0}
            minGraded={MIN_GRADED}
            series={1}
          />
        </div>
        <div className="panel kpi kpi-ring">
          <RingGauge
            label={`${modelName} calls that hit 4x`}
            value={live?.goalRatePct ?? null}
            target={t.hitRate4xPct}
            graded={live?.graded ?? 0}
            minGraded={MIN_GRADED}
            series={2}
          />
        </div>
        <div className="panel kpi">
          <span className="eyebrow">
            <RadarIcon size={13} /> Default feed · 24h
          </span>
          <span className="kpi-value num">{feed?.pace.alerts24h ?? "–"}</span>
          <div className="pace">
            <span style={{ width: `${pace}%` }} />
          </div>
          <small className="muted">
            {feed ? `${feed.pace.actualPerHour24h.toFixed(1)}/h of a ${feed.pace.targetPerHour}/h cap` : " "}
          </small>
        </div>
        <button className="panel kpi kpi-link" onClick={() => goTo("model")}>
          <span className="eyebrow">
            <BrainIcon size={13} /> Your models
          </span>
          <span className="kpi-value small">{chosenNames}</span>
          <span className="pill pill-model">
            {!modelsOn
              ? "model alerts off"
              : selected
                ? `#${selected.rank} of ${lb!.entries.length}${
                    selected.composite.score === null ? "" : ` · score ${selected.composite.score.toFixed(0)}`
                  }`
                : "–"}
          </span>
          <span className="kpi-more">
            Leaderboard <ArrowRightIcon size={13} />
          </span>
        </button>
      </section>
      <p className="window-note faint small">
        Hit rates cover the last 30 days of {modelName}'s graded calls.
      </p>

      <section className="panel feed">
        <header className="section-head">
          <div>
            <span className="eyebrow">Live feed</span>
            <h2>Your alerts{modelsOn ? " and model calls" : ""}</h2>
            <p className="muted small">
              <span className="pill pill-mine">
                <SlidersIcon size={12} /> Your alert
              </span>{" "}
              is your own filter&apos;s catch;{" "}
              <span className="pill pill-model">
                <BrainIcon size={12} /> Model
              </span>{" "}
              is a model&apos;s call. A token several models call shows once. Win = 2x within 1h of a
              realistic fill, before a 50% drop.
            </p>
          </div>
          <div className="feed-controls">
            <button
              type="button"
              role="switch"
              aria-checked={modelsOn}
              className={`switch${modelsOn ? " on" : ""}`}
              disabled={!lb || toggling}
              onClick={() => void toggleModels()}
            >
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
              Model alerts
            </button>
            {lb && <ModelPicker board={lb} disabled={!modelsOn} onChanged={changed} />}
            <span className={`live-dot ${streamLive ? "on" : ""}`}>{streamLive ? "Live" : "Polling"}</span>
          </div>
        </header>
        {feedPage.error && !feedPage.data && (
          <p className="error">Couldn&apos;t load your feed: {feedPage.error.message}</p>
        )}
        {!feedPage.data && !feedPage.error && <SkeletonCards count={4} />}
        {feedPage.data && feedPage.data.matches.length === 0 && (
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
        <div className="cards">
          {feedPage.data?.matches.map((card) => (
            <AlertCard key={card.id} card={card} now={now} labelSource />
          ))}
        </div>
        {pages > 1 && (
          <nav className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Newer
            </button>
            <span className="muted small num">
              {page} / {pages}
            </span>
            <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
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
