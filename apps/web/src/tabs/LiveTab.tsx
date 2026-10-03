import { useState } from "react";
import { api, type CuratedPage, type CuratedStats, type Leaderboard, type MatchPage } from "../api";
import { AlertCard } from "../components/AlertCard";
import { RingGauge, SkeletonCards } from "../components/Charts";
import { ModelPicker } from "../components/ModelPicker";
import { ArrowRightIcon, BrainIcon, RadarIcon, SlidersIcon } from "../components/Icons";
import { usePolling, useNow, useNudgeStream } from "../hooks";
import { ago, pct } from "../format";

/** Graded calls below which a hit rate shows as "early" rather than as a verdict. */
const MIN_GRADED = 30;

/** The main tab: your chosen model's calls as they land, with your own filter's catches beside them. */
export function LiveTab({ goTo }: { goTo: (tab: "model" | "filters") => void }) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  // Bumped when the user picks another model, so every view keyed on it refetches at once.
  const [pick, setPick] = useState(0);
  const curated = usePolling(() => api<CuratedPage>(`/curated?page=${page}`), 30_000, `${page}:${pick}`);
  const matches = usePolling(() => api<MatchPage>("/matches?page=1"), 45_000);
  const stats = usePolling(() => api<CuratedStats>("/curated/stats"), 60_000);
  const board = usePolling(() => api<Leaderboard>("/curated/models?days=30"), 120_000, String(pick));
  const curatedLive = useNudgeStream("/curated/stream", curated.reload);
  const matchesLive = useNudgeStream("/matches/stream", matches.reload);

  const t = board.data?.targets ?? { hitRate2xPct: 75, hitRate4xPct: 50 };
  const selected = board.data?.entries.find((e) => e.id === board.data?.selectedModel) ?? null;
  const live = selected?.composite.live;
  const feed = stats.data?.feed;
  const pace = feed ? Math.min(100, (feed.pace.actualPerHour24h / feed.pace.targetPerHour) * 100) : 0;
  const pages = curated.data ? Math.max(1, Math.ceil(curated.data.totalCount / curated.data.pageSize)) : 1;
  const modelName = curated.data?.model.name ?? selected?.name ?? "–";

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
            {feed ? `${feed.pace.actualPerHour24h.toFixed(1)}/h of a ${feed.pace.targetPerHour}/h cap` : " "}
          </small>
        </div>
        <button className="panel kpi kpi-link" onClick={() => goTo("model")}>
          <span className="eyebrow">
            <BrainIcon size={13} /> Your model
          </span>
          <span className="kpi-value small">{selected?.name ?? "–"}</span>
          <span className="pill pill-model">
            {selected
              ? `#${selected.rank} of ${board.data!.entries.length}${
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

      <div className="columns">
        <section className="panel feed">
          <header className="section-head">
            <div>
              <span className="eyebrow">Curated feed</span>
              <h2>{modelName}'s calls</h2>
              <p className="muted small">
                Win = 2x within 1h of a realistic fill, before a 50% drop. Every call is graded in public.
              </p>
            </div>
            <div className="feed-controls">
              {board.data && (
                <ModelPicker
                  board={board.data}
                  onChanged={() => {
                    setPage(1);
                    setPick((n) => n + 1);
                  }}
                />
              )}
              <span className={`live-dot ${curatedLive ? "on" : ""}`}>
                {curatedLive ? "Live" : "Polling"}
              </span>
            </div>
          </header>
          {curated.error && !curated.data && (
            <p className="error">Couldn't load picks: {curated.error.message}</p>
          )}
          {!curated.data && !curated.error && <SkeletonCards count={4} />}
          {curated.data && curated.data.alerts.length === 0 && (
            <div className="empty-state">
              <RadarIcon size={28} />
              <p>No calls from {modelName} yet. They land here the moment it makes one.</p>
            </div>
          )}
          <div className="cards">
            {curated.data?.alerts.map((card) => (
              <AlertCard key={card.id} card={card} now={now} />
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
        </section>

        <aside className="panel feed side">
          <header className="section-head">
            <div>
              <span className="eyebrow">Your filter</span>
              <h2>Your catches</h2>
              <p className="muted small">What your active filter picked up.</p>
            </div>
            <span className={`live-dot ${matchesLive ? "on" : ""}`}>{matchesLive ? "Live" : "Polling"}</span>
          </header>
          {!matches.data && !matches.error && <SkeletonCards count={2} />}
          {matches.data && matches.data.matches.length === 0 && (
            <div className="empty-state">
              <SlidersIcon size={28} />
              <p>Nothing caught yet.</p>
              <button className="ghost" onClick={() => goTo("filters")}>
                Tune your filter <ArrowRightIcon size={13} />
              </button>
            </div>
          )}
          <div className="cards">
            {matches.data?.matches.map((card) => (
              <AlertCard key={card.id} card={card} now={now} showFilter compact />
            ))}
          </div>
          {stats.data && (
            <div className="learning-note">
              <BrainIcon size={14} />
              <span>
                Learning from{" "}
                <strong className="num">{stats.data.training.finalizedSamples.toLocaleString()}</strong>{" "}
                graded moments. Base 2x rate {pct(stats.data.training.baseWinRatePct, 1)}
                {stats.data.curator.modelTrainedAt &&
                  `, model data to ${ago(stats.data.curator.modelTrainedAt, now)}`}
                .
              </span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
