import type { MarketWeather } from "../api";
import { usePolling } from "../hooks";
import { pct } from "../format";
import { Skeleton } from "./Charts";

/**
 * Market weather as a needle gauge: how often launches are doubling within 15 minutes over the
 * last few hours, against the last week. The dial reads the ratio of the two, from half the
 * week's rate (far left) to one and a half times it (far right), so the API's cold and hot cuts
 * (0.75 and 1.25, apps/api/src/marketWeather.ts) sit a quarter of the way in from each end.
 */
const RATIO_MIN = 0.5;
const RATIO_MAX = 1.5;
const COLD_BELOW = 0.75;
const HOT_FROM = 1.25;

/** Where on the dial (0 = far left, 1 = far right) a ratio sits. */
export function dialPosition(ratio: number): number {
  return Math.min(1, Math.max(0, (ratio - RATIO_MIN) / (RATIO_MAX - RATIO_MIN)));
}

const COLD_END = dialPosition(COLD_BELOW);
const HOT_START = dialPosition(HOT_FROM);

const CONDITION_LABEL: Record<MarketWeather["condition"], string> = {
  hot: "Hot",
  normal: "Normal",
  cold: "Cold",
  unknown: "Too early to read",
};

/**
 * The dial itself, on a 560x220 canvas. `ratio` null draws it with no needle (too few graded
 * moments to read). The tour (TourArt) draws it with a made-up reading.
 */
export function GaugeDial({
  ratio,
  label,
  caption,
}: {
  ratio: number | null;
  label: string;
  caption?: string;
}) {
  const cx = 280;
  const cy = 150;
  const r = 110;
  // Position 0..1 along the dial, left to right over the top.
  const at = (t: number, radius = r) => {
    const a = Math.PI * (1 - t);
    return [cx + radius * Math.cos(a), cy - radius * Math.sin(a)] as const;
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = at(from);
    const [x2, y2] = at(to);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const gap = 0.012;
  const needle = ratio === null ? null : at(dialPosition(ratio), r - 26);
  return (
    <svg className="tour-art weather-gauge" viewBox="0 0 560 220" role="img" aria-label={label}>
      <path className="gauge cold" d={arc(0.01, COLD_END - gap)} />
      <path className="gauge normal" d={arc(COLD_END + gap, HOT_START - gap)} />
      <path className="gauge hot" d={arc(HOT_START + gap, 0.99)} />
      {needle && (
        <path className="needle" d={`M${cx} ${cy} L${needle[0].toFixed(1)} ${needle[1].toFixed(1)}`} />
      )}
      <circle className="hub" cx={cx} cy={cy} r="9" />
      <text x={cx - r} y={cy + 32} className="label cold" textAnchor="middle">
        Cold
      </text>
      <text x={cx} y={cy - r - 14} className="label" textAnchor="middle">
        Normal
      </text>
      <text x={cx + r} y={cy + 32} className="label hot" textAnchor="middle">
        Hot
      </text>
      {caption && (
        <text x={cx} y={212} className="cap" textAnchor="middle">
          {caption}
        </text>
      )}
    </svg>
  );
}

/** The Lighthouse's live weather gauge, read from `${base}/weather`. */
export function WeatherGauge({ base }: { base: string }) {
  const q = usePolling<MarketWeather>(`${base}/weather`, 300_000);
  const w = q.data;
  if (!w) {
    // Informational: a failed reading hides the panel rather than showing an error.
    if (q.error) return null;
    return <Skeleton lines={1} height={160} />;
  }
  const reading =
    w.recentRatePct === null
      ? `Only ${w.recentGraded} graded launch moments in the last ${w.recentHours} hours, too few to read yet.`
      : w.trailingRatePct === null
        ? `${pct(w.recentRatePct, 1)} of launch moments doubled within 15 minutes over the last ${w.recentHours} hours. Not enough history yet for the ${w.trailingDays}-day average.`
        : `${pct(w.recentRatePct, 1)} of launch moments doubled within 15 minutes over the last ${w.recentHours} hours, against ${pct(w.trailingRatePct, 1)} over the last ${w.trailingDays} days.`;
  return (
    <section className={`lh-section lh-weather ${w.condition}`}>
      <div className="lh-weather-dial">
        <GaugeDial
          ratio={w.condition === "unknown" ? null : (w.ratio ?? (w.condition === "hot" ? RATIO_MAX : 1))}
          label={`Market weather: ${CONDITION_LABEL[w.condition]}. ${reading}`}
        />
      </div>
      <div className="lh-weather-text">
        <span className="eyebrow">Market weather · last {w.recentHours}h</span>
        <h3>
          <span className="weather-dot" aria-hidden="true" />
          {w.condition === "unknown" ? "Too early to read" : `${CONDITION_LABEL[w.condition]} market`}
        </h3>
        <p className="muted small">{reading}</p>
        <p className="faint small">
          {Math.round((HOT_FROM - 1) * 100)}% or more above the week reads hot,{" "}
          {Math.round((1 - COLD_BELOW) * 100)}% or more below reads cold. It helps you size or skip trades; it
          never changes or holds back an alert.
        </p>
      </div>
    </section>
  );
}
