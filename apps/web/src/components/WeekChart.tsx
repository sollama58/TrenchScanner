import { useEffect, useId, useRef, useState } from "react";
import { RULE_NOTE_UNFILTERED } from "../rates";
import { count, pct0, words, type SageTrack, type TrackDay } from "./SageView";

const PAD = { l: 36, r: 12, t: 14, b: 26 };

/** Graded calls on the narrative's coins before the "+N pts vs all calls" tag shows. */
export const EDGE_MIN_GRADED = 20;
const HEIGHT = 180;

/** A day's 2x rate: the share of its graded calls that doubled, or null with none graded. */
const rate = (d: TrackDay) => (d.graded > 0 ? d.won2x / d.graded : null);

/** "2026-10-13" -> "Tue". */
const dayText = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString([], { weekday: "short", timeZone: "UTC" });

/** A line through the days that have a value, broken across the days that don't. */
function linePath(xs: number[], ys: (number | null)[]): string {
  let d = "";
  let pen = false;
  ys.forEach((y, i) => {
    if (y === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${xs[i]!.toFixed(1)},${y.toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

/**
 * How coins like this one did this week, in the token modal: per day, the share of the models'
 * graded calls that doubled on coins in its narrative (the line with the shaded area) next to all
 * calls (the dashed line), over faint bars of how many coins in the narrative TokenSage read.
 */
export function WeekChart({ track }: { track: SageTrack }) {
  const id = useId().replace(/:/g, "");
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const name = words(track.label);
  const mine = track.days.reduce((s, d) => ({ g: s.g + d.graded, w: s.w + d.won2x, n: s.n + d.count }), {
    g: 0,
    w: 0,
    n: 0,
  });
  const all = track.all.reduce((s, d) => ({ g: s.g + d.graded, w: s.w + d.won2x }), { g: 0, w: 0 });
  const mineRate = mine.g > 0 ? mine.w / mine.g : null;
  const allRate = all.g > 0 ? all.w / all.g : null;
  // The "+N pts" tag only once the narrative's own calls are enough to tell a gap from noise: on
  // 3 graded calls one win is 33 points.
  const edge =
    mineRate !== null && allRate !== null && mine.g >= EDGE_MIN_GRADED
      ? Math.round((mineRate - allRate) * 100)
      : null;

  const days = track.days.map((d, i) => ({
    d,
    all: track.all[i],
    a: rate(d),
    b: track.all[i] ? rate(track.all[i]!) : null,
  }));
  const n = days.length;
  const max = Math.max(0.1, ...days.flatMap((r) => [r.a ?? 0, r.b ?? 0]));
  const top = Math.ceil(max * 10) / 10;
  const bottom = HEIGHT - PAD.b;
  const plotW = width - PAD.l - PAD.r;
  const slot = plotW / Math.max(1, n);
  const xs = days.map((_, i) => PAD.l + slot * (i + 0.5));
  const y = (v: number) => bottom - (v / top) * (bottom - PAD.t);
  const ya = days.map((r) => (r.a === null ? null : y(r.a)));
  const yb = days.map((r) => (r.b === null ? null : y(r.b)));
  const lineA = linePath(xs, ya);
  const lineB = linePath(xs, yb);
  // The area under the narrative's line, per unbroken run of days.
  const runs: number[][] = [];
  ya.forEach((v, i) => {
    if (v === null) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  });
  const area = runs
    .filter((r) => r.length > 1)
    .map(
      (r) =>
        `M${xs[r[0]!]!.toFixed(1)},${bottom} ` +
        r.map((i) => `L${xs[i]!.toFixed(1)},${ya[i]!.toFixed(1)}`).join(" ") +
        ` L${xs[r[r.length - 1]!]!.toFixed(1)},${bottom} Z`,
    )
    .join(" ");
  const maxCount = Math.max(1, ...days.map((r) => r.d.count));
  const barW = Math.min(26, slot * 0.5);
  const ticks = [0, top / 2, top];
  const h = hover !== null ? days[hover] : undefined;
  const today = new Date().toISOString().slice(0, 10);

  const pick = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const i = Math.floor((clientX - box.left - PAD.l) / slot);
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <section className="sage-card tm-week">
      <h4>
        {name} coins this week
        {edge !== null && (
          <span
            className={`sage-tag ${edge > 0 ? "tone-good" : edge < 0 ? "tone-warn" : "tone-neutral"}`}
            title={`Calls on ${name.toLowerCase()} coins doubled ${pct0(mineRate!)} of the time, against ${pct0(allRate!)} for all calls`}
          >
            {edge > 0 ? `+${edge}` : edge} pts vs all calls
          </span>
        )}
      </h4>
      <div className="tm-week-figs">
        <div className="tm-week-fig a">
          <label>
            <i className="swatch s1" /> {name} calls 2x&apos;d
          </label>
          <span className="num">{mineRate === null ? "–" : pct0(mineRate)}</span>
          <small className="muted num">
            {mine.g > 0
              ? `${mine.w} of ${mine.g}${mine.g < EDGE_MIN_GRADED ? ", early" : ""}`
              : "no graded calls"}
          </small>
        </div>
        <div className="tm-week-fig b">
          <label>
            <i className="swatch s2" /> All calls 2x&apos;d
          </label>
          <span className="num">{allRate === null ? "–" : pct0(allRate)}</span>
          <small className="muted num">{all.g > 0 ? `${all.w} of ${all.g}` : "no graded calls"}</small>
        </div>
        <div className="tm-week-fig">
          <label>{name} coins read</label>
          <span className="num">{count(mine.n)}</span>
          <small className="muted">this week</small>
        </div>
      </div>

      <div className="wk" ref={boxRef}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="pc-svg"
          role="img"
          aria-label={`Daily 2x rate of calls on ${name} coins and on all coins this week`}
          onPointerMove={(e) => pick(e.clientX)}
          onPointerDown={(e) => pick(e.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--series-1)" stopOpacity="0.3" />
              <stop offset="1" stopColor="var(--series-1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.l}
                x2={width - PAD.r}
                y1={y(v)}
                y2={y(v)}
                className={v === 0 ? "pc-axis" : "pc-grid"}
              />
              <text x={PAD.l - 8} y={y(v)} dy="0.35em" textAnchor="end" className="pc-tick">
                {pct0(v)}
              </text>
            </g>
          ))}
          {h && (
            <rect
              className="wk-hover"
              x={xs[hover!]! - slot / 2}
              y={PAD.t - 6}
              width={slot}
              height={bottom - PAD.t + 6}
              rx={6}
            />
          )}
          {days.map((r, i) =>
            r.d.count > 0 ? (
              <rect
                key={`c-${r.d.day}`}
                className="wk-count"
                x={xs[i]! - barW / 2}
                width={barW}
                y={bottom - (r.d.count / maxCount) * (bottom - PAD.t) * 0.3}
                height={(r.d.count / maxCount) * (bottom - PAD.t) * 0.3}
                rx={3}
              />
            ) : null,
          )}
          {area && <path d={area} fill={`url(#${id}-area)`} />}
          {lineB && <path d={lineB} className="wk-line b" />}
          {lineA && <path d={lineA} className="wk-line a" />}
          {days.map((r, i) => (
            <g key={r.d.day}>
              {yb[i] !== null && (
                <circle cx={xs[i]} cy={yb[i]!} r={hover === i ? 4 : 2.5} className="wk-dot b" />
              )}
              {ya[i] !== null && (
                <circle cx={xs[i]} cy={ya[i]!} r={hover === i ? 5 : 3.5} className="wk-dot a" />
              )}
              <text
                x={xs[i]}
                y={HEIGHT - 8}
                textAnchor="middle"
                className={`pc-tick${r.d.day === today ? " wk-today" : ""}`}
              >
                {r.d.day === today ? "Today" : dayText(r.d.day)}
              </text>
            </g>
          ))}
        </svg>
        {h && (
          <div
            className="pc-tip wk-tip"
            style={{
              top: 6,
              left: xs[hover!]! > width / 2 ? undefined : xs[hover!]! + slot / 2 + 4,
              right: xs[hover!]! > width / 2 ? width - xs[hover!]! + slot / 2 + 4 : undefined,
            }}
          >
            <span className="faint">{h.d.day === today ? "Today" : dayText(h.d.day)}</span>
            <span>
              <i className="swatch s1" /> {name}:{" "}
              <strong className="num">
                {h.a === null ? "no graded calls" : `${pct0(h.a)} (${h.d.won2x}/${h.d.graded})`}
              </strong>
            </span>
            <span>
              <i className="swatch s2" /> All:{" "}
              <strong className="num">
                {h.b === null || !h.all ? "no graded calls" : `${pct0(h.b)} (${h.all.won2x}/${h.all.graded})`}
              </strong>
            </span>
            <span className="faint num">
              {h.d.count} {name.toLowerCase()} coin{h.d.count === 1 ? "" : "s"} read
            </span>
          </div>
        )}
      </div>
      <p className="faint small tm-week-note">
        Each day, the share of the models&apos; graded calls that doubled: on {name.toLowerCase()} coins and
        on all coins. Bars are the {name.toLowerCase()} coins TokenSage read. The gap to all calls shows once{" "}
        {EDGE_MIN_GRADED} of its calls are graded. {RULE_NOTE_UNFILTERED}
      </p>
    </section>
  );
}
