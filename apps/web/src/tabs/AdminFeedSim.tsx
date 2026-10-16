import { useMemo, useState } from "react";
import type { FeedCatch, FeedStats, Leaderboard } from "../api";
import { usePolling } from "../hooks";
import { pct, shortAddress } from "../format";
import { Load, Panel, Table, Tag, n } from "./adminShared";

/**
 * Admin › Feed simulator (user ask 2026-10-16): pick any models and any switched-on filters and see
 * how a feed of them would have done over a window, four ways: either side (Model alerts on), both
 * (Settings' "Only alerts both caught"), the models alone and the filters alone. The hit rates are
 * the Live feed's Stats tiles and the coverage is its Feed catch meter, computed the same way
 * (GET /admin/feed-sim).
 */

const DAYS = [1, 7, 30] as const;
type Days = (typeof DAYS)[number];

interface SimFilter {
  id: string;
  name: string;
  walletAddress: string;
  isActive: boolean;
  deletedAt: string | null;
  matches7d: number;
}

interface FeedSim {
  days: number;
  since: string;
  models: string[];
  filters: string[];
  rows: { mode: "either" | "both" | "models" | "filters"; stats: FeedStats; catch: FeedCatch }[];
  truncated: boolean;
}

const MODE_LABEL: Record<FeedSim["rows"][number]["mode"], string> = {
  either: "Either (models + filters)",
  both: "Both caught",
  models: "Models only",
  filters: "Filters only",
};

export function FeedSimAdmin() {
  const board = usePolling<Leaderboard>("/curated/models?days=30", 300_000);
  const report = usePolling<{ filters: SimFilter[] }>("/admin/filters", 300_000);
  const [days, setDays] = useState<Days>(7);
  // Null until picked by hand: the admin's own feed models to start.
  const [models, setModels] = useState<string[] | null>(null);
  const [filters, setFilters] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const pickedModels = models ?? board.data?.selectedModels ?? [];

  const active = useMemo(
    () =>
      (report.data?.filters ?? [])
        .filter((f) => f.isActive && !f.deletedAt)
        .sort((a, b) => b.matches7d - a.matches7d),
    [report.data],
  );
  const q = query.trim().toLowerCase();
  const shown = q
    ? active.filter((f) => f.name.toLowerCase().includes(q) || f.walletAddress.toLowerCase().includes(q))
    : active;

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const path = `/admin/feed-sim?days=${days}&models=${pickedModels.join(",")}&filters=${[...filters].sort().join(",")}`;
  const sim = usePolling<FeedSim>(path, 300_000);
  const target = board.data?.targets.hitRate2xPct ?? 75;

  return (
    <>
      <Panel
        title="Feed simulator"
        note="Pick models and switched-on filters to see how a feed of them would have done: its 2x and 4x hit rates as the Stats tiles grade them, and its coverage as the Feed catch meter counts it (runners, tokens that doubled, it caught)."
        actions={
          <div className="segmented" role="tablist" aria-label="Window">
            {DAYS.map((d) => (
              <button
                key={d}
                role="tab"
                aria-selected={d === days}
                className={d === days ? "on" : ""}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
        }
      >
        <Load q={sim}>
          {(s) => (
            <>
              <Table
                head={["Feed", "Alerts", "Graded", "Hit 2x", "Hit 4x", "Coverage", "Runners caught"]}
                rows={s.rows.map((r) => [
                  <strong key="m">{MODE_LABEL[r.mode]}</strong>,
                  n(r.stats.alerts),
                  n(r.stats.graded),
                  r.stats.hit2xPct === null ? (
                    "–"
                  ) : (
                    <Tag key="h" tone={r.stats.hit2xPct >= target ? "ok" : "muted"}>
                      {pct(r.stats.hit2xPct, 1)}
                    </Tag>
                  ),
                  r.stats.hit4xPct === null ? "–" : pct(r.stats.hit4xPct, 1),
                  r.catch.pct === null ? "–" : pct(r.catch.pct, 1),
                  `${n(r.catch.caught)} of ${n(r.catch.runners)}`,
                ])}
              />
              <p className="faint small">
                Over the last {s.days === 1 ? "day" : `${s.days} days`}, with {s.models.length} model
                {s.models.length === 1 ? "" : "s"} and {s.filters.length} filter
                {s.filters.length === 1 ? "" : "s"}. Several filters alerting on one token within 6 hours
                count once. Hit rates count graded alerts only; the 2x goal is {target}%.
                {s.truncated && " Capped at 20,000 alerts a side, so the window is cut short."}
              </p>
            </>
          )}
        </Load>
      </Panel>
      <div className="feed-sim-picks">
        <Panel title="Models" note={`${pickedModels.length} picked. Starts as your own feed's models.`}>
          <Load q={board}>
            {(b) => (
              <div className="feed-sim-list">
                {b.entries.map((e) => {
                  const on = pickedModels.includes(e.id);
                  return (
                    <label key={e.id} className={`checklist-row${on ? " on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setModels(toggle(pickedModels, e.id))}
                      />
                      <span className="checklist-name">{e.name}</span>
                      <span className="faint small num">
                        {e.composite.live.winRatePct === null ? "–" : pct(e.composite.live.winRatePct, 0)} 2x
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </Load>
        </Panel>
        <Panel
          title="Filters"
          note={`${filters.length} picked of ${active.length} switched on, busiest first.`}
          actions={
            filters.length > 0 ? (
              <button type="button" className="ghost small-btn" onClick={() => setFilters([])}>
                Clear
              </button>
            ) : undefined
          }
        >
          <input
            type="search"
            className="feed-sim-search"
            placeholder="Filter name or wallet"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Load q={report}>
            {() => (
              <div className="feed-sim-list">
                {shown.length === 0 && <p className="muted small">No switched-on filter matches.</p>}
                {shown.map((f) => {
                  const on = filters.includes(f.id);
                  return (
                    <label key={f.id} className={`checklist-row${on ? " on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setFilters((l) => toggle(l, f.id))}
                      />
                      <span className="checklist-name">
                        {f.name} <span className="faint small">{shortAddress(f.walletAddress)}</span>
                      </span>
                      <span className="faint small num">{n(f.matches7d)} / 7d</span>
                    </label>
                  );
                })}
              </div>
            )}
          </Load>
        </Panel>
      </div>
    </>
  );
}
