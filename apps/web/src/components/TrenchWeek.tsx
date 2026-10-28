import { useId, useState, type PointerEvent } from "react";
import { usePolling } from "../hooks";
import {
  agoLabel,
  agoWords,
  deltaText,
  sparkPath,
  statDelta,
  statText,
  TRENCH_STATS,
  type StatSpec,
  type TrenchWeekAnswer,
} from "../marketBar";
import { Skeleton } from "./Skeleton";
import { ShareButton } from "./ShareImageDialog";

/**
 * Market weather's trench stats (user ask 2026-10-24): the Live tab's market-bar stats for the last
 * two summed hours, each against the same two hours 2h, 6h, 24h, 48h, 72h and a week earlier, with
 * the week's trend behind it as a line of back-to-back two-hour windows. Aggregates only, read from
 * `${base}/market/trench/week` (apps/api/src/marketBar.ts buildTrenchWeek).
 */

const POLL_MS = 5 * 60_000;
const SPARK_W = 240;
const SPARK_H = 56;

/** "13:00": the windows start and end on the hour. */
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "Tue 13:00–15:00", for a point on the week's line. */
const windowText = (from: string, to: string) =>
  `${new Date(from).toLocaleDateString([], { weekday: "short" })} ${hhmm(from)}–${hhmm(to)}`;

export function TrenchWeek({ base }: { base: string }) {
  const q = usePolling<TrenchWeekAnswer>(`${base}/market/trench/week`, POLL_MS);
  const d = q.data;
  if (!d) {
    // Informational, like the gauge: a failed read leaves the rest of the weather standing.
    if (q.error) return null;
    return <Skeleton lines={3} height={64} />;
  }
  const cur = d.current;
  return (
    <div className={`lh-trench${q.stale ? " stale" : ""}`} aria-busy={q.stale}>
      <div className="lh-trench-head">
        <div>
          <span className="eyebrow">
            The trenches · last {d.windowHours}h · {hhmm(cur.from)}–{hhmm(cur.to)}
          </span>
          <h3>Against the same {d.windowHours} hours earlier</h3>
        </div>
        <ShareButton
          title="The trenches against the week"
          fileName="trenchscanner-trench-weather"
          caption={`TrenchScanner: the trenches' last ${d.windowHours} hours against the last week`}
          wide
          render={() => import("./lighthouseCards").then((m) => m.renderTrenchWeekCard(d))}
        />
      </div>
      <div className="lh-trench-grid">
        {TRENCH_STATS.map((s) => (
          <StatTile key={s.key} spec={s} data={d} />
        ))}
      </div>
      <p className="faint small lh-trench-foot">
        {cur.samples.graded.toLocaleString()} graded calls · {cur.samples.screened.toLocaleString()} tokens
        screened in the window. The line is the last week in {d.windowHours}-hour steps; hover it to read any
        of them. Rates need {d.minSample}+ graded calls, and the newest hours keep grading for an hour. They
        count each coin's decision moments; the market weather also counts the hourly re-reads of every coin
        in the band, older ones included, so its 2x rate reads lower.
      </p>
    </div>
  );
}

function StatTile({ spec, data }: { spec: StatSpec; data: TrenchWeekAnswer }) {
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId();
  const now = data.current.stats[spec.key];
  const values = data.series.map((w) => w.stats[spec.key]);
  const line = sparkPath(values, SPARK_W, SPARK_H, spec.kind === "count");
  const last = values.length - 1;
  const at = hover ?? last;
  const atValue = values[at] ?? null;
  const shown = hover === null ? now : atValue;
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(t * last));
  };
  const w = data.series[at];
  return (
    <div className="lh-trench-tile">
      <div className="lh-trench-top">
        <div className="lh-trench-read">
          <span className="lh-trench-label" title={spec.title}>
            {spec.label}
          </span>
          <span className={`num lh-trench-value${hover === null ? "" : " past"}`}>
            {statText(spec, shown)}
          </span>
          <span className="faint lh-trench-when">
            {hover === null || !w ? "now" : windowText(w.from, w.to)}
          </span>
        </div>
        <svg
          className="lh-spark"
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${spec.label} over the last week, in ${data.windowHours}-hour steps`}
          onPointerMove={move}
          onPointerDown={move}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={line.area} fill={`url(#${gradId})`} stroke="none" />
          <path className="lh-spark-line" d={line.d} />
          {hover !== null && (
            <line className="lh-spark-rule" x1={line.x(at)} x2={line.x(at)} y1={0} y2={SPARK_H} />
          )}
          {atValue !== null && (
            <circle className="lh-spark-dot" cx={line.x(at)} cy={line.y(atValue)} r={3.2} />
          )}
        </svg>
      </div>
      <ul className="lh-trench-deltas" aria-label={`${spec.label} against earlier windows`}>
        {data.compare.map((c) => {
          const then = c.stats[spec.key];
          const dl = statDelta(spec, now, then);
          const words =
            dl.value === null
              ? `no reading ${agoWords(c.hoursAgo)} ago`
              : dl.dir === "flat"
                ? `about the same as ${agoWords(c.hoursAgo)} ago`
                : `${dl.dir === "up" ? "up" : "down"} ${deltaText(dl)} on ${agoWords(c.hoursAgo)} ago`;
          return (
            <li
              key={c.hoursAgo}
              className={`lh-trench-delta ${dl.tone ?? ""}`}
              title={`${windowText(c.from, c.to)}: ${statText(spec, then)} (${words})`}
            >
              <span className="lh-trench-ago">vs {agoLabel(c.hoursAgo)}</span>
              <span className="num lh-trench-chg">
                {dl.dir === null ? (
                  <span className="faint">–</span>
                ) : dl.dir === "flat" ? (
                  <span className="faint">≈</span>
                ) : (
                  <>
                    <span aria-hidden>{dl.dir === "up" ? "▲" : "▼"}</span>
                    {deltaText(dl)}
                  </>
                )}
              </span>
              <span className="sr-only">{words}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
