import { useEffect, useMemo, useState } from "react";
import type { Leaderboard, LighthouseDimension, LighthouseHistory, LighthouseHistoryBucket } from "../api";
import { usePolling } from "../hooks";
import { ago } from "../format";
import { Skeleton } from "../components/Charts";
import { TrendChart, fmt } from "../components/TrendChart";
import { LighthouseBody, WINDOWS as NOW_WINDOWS, type Days } from "../components/MarketLighthouse";
import { ChevronDownIcon, CloseIcon, DownloadIcon, LighthouseIcon, PlusIcon } from "../components/Icons";
import {
  BREAKDOWN_MODES,
  BUCKETS,
  DIMENSIONS,
  dimensionLabel,
  METRICS,
  PRESETS,
  WINDOWS,
  breakdownSeries,
  bucketAllowed,
  bucketLabel,
  canAdd,
  hasPanel,
  defaultBucketFor,
  defaultPanels,
  delta,
  historyCsv,
  loadPanels,
  metricById,
  metricSeries,
  panelTitle,
  savePanels,
  type BreakdownMode,
  type ChartKind,
  type MetricId,
  type Panel,
} from "../lighthouseMetrics";

/**
 * The Lighthouse tab: the Market Lighthouse's whole history, for building trends over weeks and
 * months. The top is the window's headline numbers against the span before it; then the charts,
 * which the reader composes - any metrics on one chart, as lines or bars, or a breakdown of the
 * coins read by narrative, flag and so on - and which this browser remembers; then the Live tab's
 * Lighthouse itself for the last day or week. Guests see the same aggregates-only answer, from the
 * guest routes, because nothing here names a coin.
 */

const DEFAULT_TARGETS = { hitRate2xPct: 75, hitRate4xPct: 50 };

const VIEW_KEY = "trenchscanner.lighthouse.view.v1";
interface View {
  days: number;
  bucket: LighthouseHistoryBucket;
}
function loadView(): View {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<View>) : {};
    const days = WINDOWS.some((w) => w.days === v.days) ? v.days! : 30;
    const bucket =
      BUCKETS.some((b) => b.id === v.bucket) && bucketAllowed(v.bucket!, days)
        ? v.bucket!
        : defaultBucketFor(days);
    return { days, bucket };
  } catch {
    return { days: 30, bucket: "day" };
  }
}

export function LighthouseTab({ guest = false }: { guest?: boolean }) {
  const api = guest ? "/guest" : "/curated";
  const [view, setView] = useState<View>(loadView);
  const [panels, setPanels] = useState<Panel[]>(loadPanels);
  const [nowDays, setNowDays] = useState<Days>(7);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // Private mode: the view simply doesn't persist.
    }
  }, [view]);
  useEffect(() => savePanels(panels), [panels]);

  const history = usePolling<LighthouseHistory>(historyPath(api, view), 300_000);
  // The goals the models are held to, from the leaderboard every other tab already fetched.
  const board = usePolling<Leaderboard>(`${api}/models?days=30`, 600_000);
  const targets = board.data?.targets ?? DEFAULT_TARGETS;

  const setDays = (days: number) =>
    setView((v) => ({
      ...v,
      days,
      bucket: bucketAllowed(v.bucket, days) ? v.bucket : defaultBucketFor(days),
    }));

  const update = (id: string, f: (p: Panel) => Panel) =>
    setPanels((ps) => ps.map((p) => (p.id === id ? f(p) : p)));
  const remove = (id: string) => setPanels((ps) => ps.filter((p) => p.id !== id));
  const move = (id: string, dir: -1 | 1) =>
    setPanels((ps) => {
      const i = ps.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ps.length) return ps;
      const next = [...ps];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const d = history.data;
  const win = WINDOWS.find((w) => w.days === view.days)!;

  return (
    <div className="stack lh-page">
      <section className="panel lht-hero">
        <div className="lh-beam" aria-hidden />
        <div className="lh-head-row">
          <span className="lh-head-icon" aria-hidden>
            <LighthouseIcon size={22} />
          </span>
          <div className="lh-head-text">
            <h2>Lighthouse</h2>
            <p className="muted">
              How the tokens that pass our pre-checks do, what the models make of them, and what TokenSage
              sees across new coins: kept hour by hour for good, so trends can be read over weeks and months.
            </p>
          </div>
        </div>
        <div className="lht-controls">
          <div className="lht-control">
            <span className="lht-control-label">Window</span>
            <div className="segmented small" role="tablist" aria-label="Window">
              {WINDOWS.map((w) => (
                <button
                  key={w.days}
                  role="tab"
                  aria-selected={w.days === view.days}
                  className={w.days === view.days ? "on" : ""}
                  onClick={() => setDays(w.days)}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          <div className="lht-control">
            <span className="lht-control-label">Per</span>
            <div className="segmented small" role="tablist" aria-label="Bucket">
              {BUCKETS.map((b) => {
                const ok = bucketAllowed(b.id, view.days);
                return (
                  <button
                    key={b.id}
                    role="tab"
                    aria-selected={b.id === view.bucket}
                    className={b.id === view.bucket ? "on" : ""}
                    disabled={!ok}
                    title={ok ? undefined : "Hourly points cover up to 30 days"}
                    onClick={() => setView((v) => ({ ...v, bucket: b.id }))}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            className="ghost stats-btn lht-csv"
            disabled={!d}
            onClick={() => d && downloadCsv(d, view)}
            title="The window's sums and rates per bucket, as a spreadsheet"
          >
            <DownloadIcon size={14} />
            CSV
          </button>
        </div>
        {d && (
          <p className="faint small lht-coverage">
            {d.coverage.oldestHour
              ? `History kept since ${new Date(d.coverage.oldestHour).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`
              : "No history summed yet"}
            {d.coverage.summedAt ? ` · last summed ${ago(d.coverage.summedAt)}` : ""}
            {" · "}
            exit plan: {d.exitPlan}
          </p>
        )}
      </section>

      {history.error && !d && (
        <p className="error">Couldn&apos;t load the Lighthouse history: {history.error.message}</p>
      )}
      {!d && !history.error && (
        <section className="panel">
          <Skeleton lines={2} height={56} />
          <Skeleton lines={6} />
        </section>
      )}

      {d && (
        <>
          <section
            className={`panel lht-kpis${history.stale ? " stale" : ""}`}
            aria-busy={history.stale}
            aria-label="Headline numbers"
          >
            <Kpi d={d} id="field2x" label="2x rate, screened field" span={win.long} />
            <Kpi d={d} id="fieldReturn" label="Avg return, screened field" span={win.long} />
            <Kpi d={d} id="calls2x" label="2x rate, model calls" span={win.long} />
            <Kpi d={d} id="coinsRead" label="Coins TokenSage read" span={win.long} />
          </section>

          <section className={`panel lht-charts${history.stale ? " stale" : ""}`} aria-busy={history.stale}>
            <header className="section-head">
              <div>
                <span className="eyebrow">Trends · last {win.long}</span>
                <h2>Your charts</h2>
                <p className="faint small">
                  Pick any metrics for a chart, lines or bars, or break the coins read down by what TokenSage
                  saw. This browser remembers your layout.
                </p>
              </div>
              <div className="feed-controls">
                <label className="lht-add">
                  <PlusIcon size={14} />
                  <select
                    value=""
                    aria-label="Add a chart"
                    onChange={(e) => {
                      const preset = PRESETS[Number(e.target.value)];
                      if (!preset) return;
                      const made = preset.make();
                      setPanels((ps) => (hasPanel(ps, made) ? ps : [...ps, made]));
                    }}
                  >
                    <option value="" disabled>
                      Add chart…
                    </option>
                    {PRESETS.map((p, i) => {
                      const active = hasPanel(panels, p.make());
                      return (
                        <option key={p.label} value={i} disabled={active}>
                          {p.label}
                          {active ? " (on the page)" : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <button type="button" className="ghost stats-btn" onClick={() => setPanels(defaultPanels())}>
                  Reset
                </button>
              </div>
            </header>
            {panels.length === 0 && (
              <p className="muted small">No charts. Add one above, or reset to the defaults.</p>
            )}
            <div className="lht-grid">
              {panels.map((p, i) => (
                <ChartPanel
                  key={p.id}
                  panel={p}
                  history={d}
                  api={api}
                  view={view}
                  targets={targets}
                  first={i === 0}
                  last={i === panels.length - 1}
                  onChange={(f) => update(p.id, f)}
                  onRemove={() => remove(p.id)}
                  onMove={(dir) => move(p.id, dir)}
                />
              ))}
            </div>
          </section>
        </>
      )}

      <section className="panel lht-now">
        <header className="section-head">
          <div>
            <span className="eyebrow">Right now</span>
            <h2>The last {nowDays === 1 ? "24 hours" : "7 days"} in full</h2>
            <p className="faint small">
              Everything behind the headline numbers the Live tab&apos;s Lighthouse button shows.
            </p>
          </div>
          <div className="segmented small" role="tablist" aria-label="Window">
            {NOW_WINDOWS.map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={w === nowDays}
                className={w === nowDays ? "on" : ""}
                onClick={() => setNowDays(w)}
              >
                {w === 1 ? "24h" : "7d"}
              </button>
            ))}
          </div>
        </header>
        <LighthouseBody base={api} days={nowDays} />
      </section>
    </div>
  );
}

function Kpi({ d, id, label, span }: { d: LighthouseHistory; id: MetricId; label: string; span: string }) {
  const m = metricById(id);
  const value = m.value(d.totals);
  const change = delta(m, d.totals, d.previous);
  const tone = change === null || Math.abs(change) < 0.05 ? "" : change > 0 ? "lh-up" : "lh-down";
  const changeText =
    change === null
      ? d.previous
        ? "no comparison yet"
        : "the whole history"
      : `${change > 0 ? "▲" : change < 0 ? "▼" : "="} ${m.unit === "count" ? fmt(Math.abs(change), "count") : `${Math.abs(change).toFixed(1)} pts`} vs the ${span} before`;
  return (
    <div className="lh-kpi">
      <span className="lh-kpi-label">{label}</span>
      <span
        className={`lh-kpi-value num${m.unit === "ret" ? ` ${value === null ? "" : value >= 0 ? "lh-up" : "lh-down"}` : ""}`}
      >
        {fmt(value, m.unit)}
      </span>
      <span className={`small ${tone || "muted"}`}>{changeText}</span>
    </div>
  );
}

// The dimension is always spelled out, so the tab's own request, a category breakdown's and the
// boot prefetch (index.html, routes.ts) share one cache entry instead of fetching the same answer
// under two keys.
const historyPath = (api: string, view: View, dimension: LighthouseDimension = "category") =>
  `${api}/lighthouse/history?days=${view.days}&bucket=${view.bucket}&dimension=${dimension}`;

function ChartPanel({
  panel,
  history,
  api,
  view,
  targets,
  first,
  last,
  onChange,
  onRemove,
  onMove,
}: {
  panel: Panel;
  history: LighthouseHistory;
  api: string;
  view: View;
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  first: boolean;
  last: boolean;
  onChange: (f: (p: Panel) => Panel) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const [editing, setEditing] = useState(false);
  const breakdown = "breakdown" in panel;
  const setKind = (k: ChartKind) => onChange((p) => ({ ...p, kind: k }));
  const setDimension = (dimension: LighthouseDimension) =>
    onChange((p) => ("breakdown" in p ? { ...p, dimension } : p));
  const toggle = (id: MetricId) =>
    onChange((p) => {
      if ("breakdown" in p) return p;
      const has = p.metrics.includes(id);
      return {
        ...p,
        metrics: has
          ? p.metrics.filter((m) => m !== id)
          : canAdd(p.metrics, id)
            ? [...p.metrics, id]
            : p.metrics,
      };
    });

  return (
    <article className="lht-panel">
      <header className="lht-panel-head">
        <h3>{panelTitle(panel)}</h3>
        <div className="lht-panel-tools">
          {breakdown && (
            <select
              className="lht-dimension"
              value={panel.dimension}
              aria-label="Break down by"
              title="Break down by"
              onChange={(e) => setDimension(e.target.value as LighthouseDimension)}
            >
              {DIMENSIONS.map((dim) => (
                <option key={dim.id} value={dim.id}>
                  {dim.label}
                </option>
              ))}
            </select>
          )}
          <div className="segmented small" role="tablist" aria-label="Chart type">
            {(["line", "bars"] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={panel.kind === k}
                className={panel.kind === k ? "on" : ""}
                onClick={() => setKind(k)}
              >
                {k === "line" ? "Lines" : "Bars"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`ghost icon-btn${editing ? " on" : ""}`}
            aria-expanded={editing}
            onClick={() => setEditing((o) => !o)}
            title={breakdown ? "What to draw" : "Pick metrics"}
          >
            <ChevronDownIcon size={14} />
          </button>
          <button
            type="button"
            className="ghost icon-btn"
            disabled={first}
            onClick={() => onMove(-1)}
            aria-label="Move up"
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className="ghost icon-btn"
            disabled={last}
            onClick={() => onMove(1)}
            aria-label="Move down"
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            className="ghost icon-btn"
            onClick={onRemove}
            aria-label="Remove chart"
            title="Remove chart"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </header>
      {editing &&
        (breakdown ? (
          <div className="lht-picker">
            <span className="lht-picker-group">
              Draw, for each {dimensionLabel(panel.dimension).toLowerCase()}
            </span>
            <div className="lht-chips">
              {BREAKDOWN_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`chip lht-chip${panel.breakdown === m.id ? " on" : ""}`}
                  aria-pressed={panel.breakdown === m.id}
                  onClick={() =>
                    onChange((p) => ({
                      id: p.id,
                      kind: m.kind,
                      breakdown: m.id,
                      dimension: "breakdown" in p ? p.dimension : "category",
                    }))
                  }
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="faint small">
              The biggest five labels get their own series; the rest are &quot;other&quot;. The menu beside
              the chart type picks what to break down by. A label&apos;s 2x rate shows once it has five graded
              calls in a bucket.
            </p>
          </div>
        ) : (
          <div className="lht-picker">
            {(["Screened field", "Model calls", "TokenSage"] as const).map((group) => (
              <div key={group} className="lht-picker-row">
                <span className="lht-picker-group">{group}</span>
                <div className="lht-chips">
                  {METRICS.filter((m) => m.group === group).map((m) => {
                    const on = panel.metrics.includes(m.id);
                    const ok = on || canAdd(panel.metrics, m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={`chip lht-chip${on ? " on" : ""}`}
                        aria-pressed={on}
                        disabled={!ok}
                        title={ok ? undefined : "A chart holds up to five series on two scales"}
                        onClick={() => toggle(m.id)}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      {"breakdown" in panel ? (
        <BreakdownChart panel={panel} api={api} view={view} fallback={history} />
      ) : (
        <MetricsChart panel={panel} history={history} targets={targets} />
      )}
    </article>
  );
}

function MetricsChart({
  panel,
  history,
  targets,
}: {
  panel: Extract<Panel, { metrics: MetricId[] }>;
  history: LighthouseHistory;
  targets: { hitRate2xPct: number; hitRate4xPct: number };
}) {
  const bucket = history.window.bucket;
  const labels = useMemo(() => history.series.map((p) => bucketLabel(p.at, bucket)), [history, bucket]);
  const series = useMemo(() => metricSeries(history, panel.metrics, targets), [history, panel, targets]);
  return <TrendChart labels={labels} series={series} kind={panel.kind} partialLast />;
}

/**
 * A breakdown chart fetches the window for its own dimension (the API serves one dimension per
 * answer, from a five-minute cache), so two breakdown charts can split by different things. The
 * tab's own answer, which is the narrative split, stands in while the first fetch is out.
 */
function BreakdownChart({
  panel,
  api,
  view,
  fallback,
}: {
  panel: Extract<Panel, { breakdown: BreakdownMode }>;
  api: string;
  view: View;
  fallback: LighthouseHistory;
}) {
  const own = usePolling<LighthouseHistory>(historyPath(api, view, panel.dimension), 300_000);
  const history = own.data ?? (panel.dimension === fallback.window.dimension ? fallback : null);
  const h = history ?? fallback;
  const bucket = h.labels.bucket;
  const labels = useMemo(() => h.labels.buckets.map((p) => bucketLabel(p.at, bucket)), [h, bucket]);
  const series = useMemo(() => breakdownSeries(h, panel.breakdown), [h, panel.breakdown]);
  if (!history) {
    if (own.error) return <p className="error">Couldn&apos;t load this breakdown: {own.error.message}</p>;
    return <Skeleton lines={5} />;
  }
  const stale = own.stale || (!own.data && !!history);
  return (
    <div className={stale ? "stale" : undefined} aria-busy={stale}>
      <TrendChart
        labels={labels}
        series={series}
        kind={panel.kind === "bars" ? "stacked" : "line"}
        partialLast
      />
    </div>
  );
}

/** Hands the window's sums to the browser as a file. */
function downloadCsv(d: LighthouseHistory, view: View) {
  const blob = new Blob([historyCsv(d)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lighthouse-${view.days === 0 ? "all" : `${view.days}d`}-per-${view.bucket}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
