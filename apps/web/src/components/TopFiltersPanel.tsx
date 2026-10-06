import { useState } from "react";
import { post, ApiError, type FilterBoard, type FilterBoardEntry } from "../api";
import { invalidate } from "../cache";
import { usePolling } from "../hooks";
import { pct } from "../format";
import { criteriaLines } from "../filterFields";
import { ScoreBar } from "./ScoreBar";
import { CopyIcon, TrophyIcon } from "./Icons";
import { Skeleton } from "./Charts";

/**
 * The public filter leaderboard: filters their owners chose to share, ranked by how far their
 * graded alerts have proven themselves toward the 75% / 50% targets (the model score), with a
 * one-click copy into the reader's own saved filters. A card on the Filters tab; `onCopied` lets
 * the tab reload its list so the copy shows up straight away.
 */
export function TopFiltersPanel({ onCopied }: { onCopied: () => void }) {
  const board = usePolling<FilterBoard>("/filters/leaderboard", 300_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const copy = async (e: FilterBoardEntry) => {
    setBusy(e.id);
    setMessage(null);
    try {
      await post(`/filters/leaderboard/${e.id}/copy`);
      invalidate("/filters");
      onCopied();
      setMessage({ text: `Copied “${e.name}” to your filters. It's saved but not active yet.`, ok: true });
    } catch (err) {
      setMessage({
        text: err instanceof ApiError || err instanceof Error ? err.message : String(err),
        ok: false,
      });
    } finally {
      setBusy(null);
    }
  };

  const data = board.data;
  return (
    <section className="panel" id="top-filters">
      <header className="section-head">
        <div>
          <span className="eyebrow">Top filters</span>
          <h2>Filters ranked by their alerts</h2>
          <p className="muted">
            Filters their owners chose to share, scored 0-100 the same way as the models: 50 points for the
            proven 2x rate, 30 for the 4x rate (targets{" "}
            {data ? `${data.targets.hitRate2xPct}% / ${data.targets.hitRate4xPct}%` : "75% / 50%"}), and 20
            for run size, how far the calls ran over their 24h watch (target a{" "}
            {data ? 2 ** data.targets.runDoublings : 4}x average, capped at 100x). A win is 2x on the alert
            price within 15 minutes (4x within 30) before a 50% drop.
          </p>
          {data && (
            <p className="muted small">
              Each record covers the last {data.windowDays} days since the filter's settings last changed, and
              a filter needs {data.minGradedToRank} graded alerts to rank. Owners' wallets are never shown.
              Share one of yours from its settings above.
            </p>
          )}
        </div>
      </header>
      {message && <p className={message.ok ? "notice" : "error"}>{message.text}</p>}
      {board.error && !data && <p className="error">Couldn't load the leaderboard: {board.error.message}</p>}
      {!data && !board.error && <Skeleton height={220} />}
      {data && data.ranked.length === 0 && (
        <div className="empty-state">
          <TrophyIcon size={28} />
          <p>
            {data.sharedCount === 0
              ? "No one has shared a filter yet. Turn on “Share on the filter leaderboard” in one of yours to be first."
              : `No shared filter has ${data.minGradedToRank} graded alerts yet. They rank as soon as they do.`}
          </p>
        </div>
      )}
      {data && data.ranked.length > 0 && (
        <ol className="filter-board">
          {data.ranked.map((e) => (
            <BoardEntry key={e.id} entry={e} busy={busy} onCopy={copy} targets={data.targets} />
          ))}
        </ol>
      )}

      {data && data.warmingUp.length > 0 && (
        <details className="board-warming">
          <summary>
            <strong>Warming up</strong>{" "}
            <span className="muted small">
              shared filters with fewer than {data.minGradedToRank} graded alerts ({data.warmingUp.length})
            </span>
          </summary>
          <ol className="filter-board">
            {data.warmingUp.map((e) => (
              <BoardEntry key={e.id} entry={e} busy={busy} onCopy={copy} targets={data.targets} />
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function BoardEntry({
  entry: e,
  busy,
  onCopy,
  targets,
}: {
  entry: FilterBoardEntry;
  busy: string | null;
  onCopy: (e: FilterBoardEntry) => void;
  targets: FilterBoard["targets"];
}) {
  const since = new Date(e.recordSince).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <li className={`board-entry ${e.mine ? "mine" : ""}`}>
      <div className="board-rank num">{e.rank ?? "–"}</div>
      <div className="board-main">
        <div className="row gap-xs wrap">
          <strong>{e.name}</strong>
          <span className="faint small">#{e.tag}</span>
          {e.mine && <span className="pill pill-mine">Yours</span>}
          {e.retired ? (
            <span
              className="pill"
              title="Its owner deleted it; it stays here for its record and can still be copied"
            >
              Retired
            </span>
          ) : (
            !e.isActive && (
              <span
                className="pill"
                title="Its owner has another filter active, so this one isn't alerting now"
              >
                Paused
              </span>
            )
          )}
        </div>
        <ScoreBar
          score={e.score}
          band={e.band}
          title={
            e.proven2xPct === null
              ? "No graded alerts yet"
              : `Proven 2x ${e.proven2xPct}% · 4x ${e.proven4xPct}% · run ${e.provenRunDoublings} doublings`
          }
        />
        <p className="small muted board-stats">
          <strong className={`num ${(e.winRatePct ?? 0) >= targets.hitRate2xPct ? "up" : ""}`}>
            {pct(e.winRatePct)}
          </strong>{" "}
          2x ·{" "}
          <strong className={`num ${(e.goalRatePct ?? 0) >= targets.hitRate4xPct ? "up" : ""}`}>
            {pct(e.goalRatePct)}
          </strong>{" "}
          4x ·{" "}
          <span title="How far the alerts ran on average over their 24h watch (stopped-out calls count as 0)">
            runs avg <strong className="num">{runMultiple(e.avgRunDoublings)}</strong>
          </span>{" "}
          · {e.graded.toLocaleString()} graded since {since}
        </p>
        <details className="board-criteria">
          <summary className="small">Settings</summary>
          <ul className="small muted">
            {criteriaLines(e.criteria).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      </div>
      <div className="board-actions">
        <button
          onClick={() => onCopy(e)}
          disabled={busy !== null}
          title="Save these settings as a new filter of yours"
          aria-label={`Copy ${e.name} to your filters`}
        >
          <CopyIcon size={15} /> {busy === e.id ? "Copying…" : "Copy"}
        </button>
      </div>
    </li>
  );
}

/** Average run size in doublings as a multiple, e.g. 1.5 doublings -> "2.8x". */
function runMultiple(doublings: number | null): string {
  if (doublings === null) return "–";
  return `${(2 ** doublings).toFixed(1)}x`;
}
