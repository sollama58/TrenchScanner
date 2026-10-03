import { useState } from "react";
import { api, type CuratedPage, type CuratedStats, type MatchPage, type ModelInsights } from "../api";
import { AlertCard } from "../components/AlertCard";
import { TargetMeter } from "../components/Charts";
import { usePolling, useNow, useNudgeStream } from "../hooks";
import { ago, pct } from "../format";

/** The main tab: the curator's picks as they land, with your own filter's catches beside them. */
export function LiveTab({ goTo }: { goTo: (tab: "model" | "filters") => void }) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  const curated = usePolling(() => api<CuratedPage>(`/curated?page=${page}`), 30_000, String(page));
  const matches = usePolling(() => api<MatchPage>("/matches?page=1"), 45_000);
  const stats = usePolling(() => api<CuratedStats>("/curated/stats"), 60_000);
  const insights = usePolling(() => api<ModelInsights>("/curated/insights?days=30"), 120_000);
  const curatedLive = useNudgeStream("/curated/stream", curated.reload);
  const matchesLive = useNudgeStream("/matches/stream", matches.reload);

  const t = insights.data?.targets ?? { hitRate2xPct: 75, hitRate4xPct: 50 };
  const total = insights.data?.curatedAlerts.total;
  const minGraded = insights.data?.minGradedForVerdict ?? 30;
  const feed = stats.data?.feed;
  const pages = curated.data ? Math.max(1, Math.ceil(curated.data.totalCount / curated.data.pageSize)) : 1;

  return (
    <div className="stack">
      <section className="kpis">
        <div className="panel">
          <TargetMeter
            label="Picks hitting 2x (30d)"
            value={total?.hitRate2xPct ?? null}
            target={t.hitRate2xPct}
            graded={total?.graded ?? 0}
            minGraded={minGraded}
          />
        </div>
        <div className="panel">
          <TargetMeter
            label="Picks hitting 4x (30d)"
            value={total?.hitRate4xPct ?? null}
            target={t.hitRate4xPct}
            graded={total?.graded ?? 0}
            minGraded={minGraded}
          />
        </div>
        <div className="panel stat">
          <label>Picks, last 24h</label>
          <span className="big">{feed?.pace.alerts24h ?? "–"}</span>
          <small className="muted">pace cap {feed?.pace.targetPerHour ?? "–"}/h</small>
        </div>
        <button className="panel stat clickable" onClick={() => goTo("model")}>
          <label>Who is picking</label>
          <span className="big small-big">
            {stats.data?.curator.phase === "model-live" ? "Trained model" : "Heuristic"}
          </span>
          <small className="muted">
            AI reviewer: {insights.data?.curator.aiReviewMode ?? "–"} · details →
          </small>
        </button>
      </section>

      <div className="columns">
        <section className="panel feed">
          <header className="section-head">
            <div>
              <h2>Curated picks</h2>
              <p className="muted">
                The curator's calls for everyone. Win = 2x within 1h of a realistic fill, before a 50% drop.
              </p>
            </div>
            <span className={`live-dot ${curatedLive ? "on" : ""}`}>{curatedLive ? "live" : "polling"}</span>
          </header>
          {curated.error && !curated.data && (
            <p className="error">Couldn't load picks: {curated.error.message}</p>
          )}
          {curated.data && curated.data.alerts.length === 0 && (
            <p className="empty">No curated picks yet. They appear here the moment the curator makes one.</p>
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
              <span className="muted">
                Page {page} of {pages}
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
              <h2>Your filter</h2>
              <p className="muted">Tokens your active filter caught.</p>
            </div>
            <span className={`live-dot ${matchesLive ? "on" : ""}`}>{matchesLive ? "live" : "polling"}</span>
          </header>
          {matches.data && matches.data.matches.length === 0 && (
            <p className="empty">
              Nothing caught yet.{" "}
              <button className="link" onClick={() => goTo("filters")}>
                Tune your filter →
              </button>
            </p>
          )}
          <div className="cards">
            {matches.data?.matches.map((card) => (
              <AlertCard key={card.id} card={card} now={now} showFilter />
            ))}
          </div>
          {stats.data && (
            <p className="faint small">
              Learning from {stats.data.training.finalizedSamples.toLocaleString()} graded moments · base 2x
              rate {pct(stats.data.training.baseWinRatePct, 1)}
              {stats.data.curator.modelTrainedAt &&
                ` · model data to ${ago(stats.data.curator.modelTrainedAt, now)}`}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
