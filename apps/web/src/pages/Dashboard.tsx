import { useEffect, useState } from "react";
import { listMatches } from "../api/client";
import type { Match } from "../api/types";
import { TokenCard } from "../components/TokenCard";

const POLL_INTERVAL_MS = 20_000;

export function Dashboard() {
  const [page, setPage] = useState(1);
  const [matches, setMatches] = useState<Match[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pageSize, setPageSize] = useState(12);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Re-runs whenever `page` changes, and the cleanup's `cancelled` flag is what keeps this scoped
  // to "actively displayed" tokens: if the user flips pages while a request for the old page is
  // still in flight, that response is discarded instead of briefly overwriting the new page's
  // content. Each poll only ever asks the API for the 12 matches on the current page, and the API
  // itself only stamps those 12 tokens' lastViewedAt (see apps/api/src/routes/matches.ts) -
  // nothing off-page gets refreshed just because it's technically still in the feed.
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await listMatches(page);
        if (cancelled) return;
        setMatches(result.matches);
        setTotalCount(result.totalCount);
        setPageSize(result.pageSize);
        setLastUpdated(new Date());
      } catch {
        // A single failed poll isn't worth surfacing to the user - the next tick will retry.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <h2>Live Feed</h2>
        {lastUpdated && (
          <span className="dashboard__updated">Updated {lastUpdated.toLocaleTimeString()}</span>
        )}
      </div>

      {loading && matches.length === 0 && <p className="empty-state">Loading matches…</p>}

      {!loading && matches.length === 0 && (
        <p className="empty-state">
          No matches yet. Once a token in the trenches passes the rug screen and matches one of your filters,
          it'll show up here within a few minutes.
        </p>
      )}

      <div className="token-grid">
        {matches.map((match) => (
          <TokenCard key={match.id} match={match} />
        ))}
      </div>

      {totalCount > pageSize && (
        <div className="pagination">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            ← Prev
          </button>
          <span className="pagination__label">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
