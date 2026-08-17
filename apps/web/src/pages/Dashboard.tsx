import { useCallback, useEffect, useRef, useState } from "react";
import { listMatches } from "../api/client";
import type { Match } from "../api/types";
import { TokenCard } from "../components/TokenCard";

const POLL_INTERVAL_MS = 20_000;
const MAX_FEED_SIZE = 100;

export function Dashboard() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const latestMatchedAt = useRef<string | undefined>(undefined);

  const poll = useCallback(async () => {
    try {
      const fresh = await listMatches(latestMatchedAt.current);
      if (fresh.length > 0) {
        latestMatchedAt.current = fresh[0]!.matchedAt;
        setMatches((prev) => [...fresh, ...prev].slice(0, MAX_FEED_SIZE));
      }
      setLastUpdated(new Date());
    } catch {
      // A single failed poll isn't worth surfacing to the user - the next tick will retry.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll]);

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
    </div>
  );
}
