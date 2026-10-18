import type { ModelProfile } from "../api";
import {
  ArrowRightIcon,
  BookIcon,
  ChartIcon,
  ClockIcon,
  RadarIcon,
  RocketIcon,
  SearchIcon,
  ShieldIcon,
  TargetIcon,
  UsersIcon,
} from "./Icons";

/**
 * What a model does, drawn (user ask 2026-10-17: "better explanations / graphics of what they
 * do"): its goal, then a three-step picture - what it looks at, how it decides, how much of what
 * it sees it calls - and how long it remembers. Everything comes from the API's profile, so a bred
 * recipe taking a seat redraws it.
 */
export function ModelPortrait({
  profile: p,
  summary,
  liveCallsPct,
}: {
  profile: ModelProfile;
  summary: string;
  /** The share of moments its live cutoff calls now (weights), when known. */
  liveCallsPct: number | null;
}) {
  const callsPct = liveCallsPct !== null && liveCallsPct > 0 ? liveCallsPct : p.aimsToCallPct;
  const GoalIcon = GOAL_ICON[p.goal];
  return (
    <section className="mp" aria-label="What it does">
      <div className={`mp-goal mp-goal-${p.goal}`}>
        <span className="mp-goal-icon" aria-hidden>
          <GoalIcon size={18} />
        </span>
        <span>
          <small>Aims for</small>
          <strong>{p.goalText}</strong>
        </span>
      </div>
      <p className="mp-summary">{summary}</p>

      <ol className="mp-flow">
        <li className="mp-step">
          <span className="mp-step-label">
            <SearchIcon size={13} /> Looks at
          </span>
          <ReadsGlyph profile={p} />
          <span className="mp-step-text">{p.reads}</span>
        </li>
        <li className="mp-arrow" aria-hidden>
          <ArrowRightIcon size={16} />
        </li>
        <li className="mp-step">
          <span className="mp-step-label">
            <RadarIcon size={13} /> Decides
          </span>
          <MethodGlyph method={p.method} />
          <span className="mp-step-text">{p.decides}</span>
        </li>
        <li className="mp-arrow" aria-hidden>
          <ArrowRightIcon size={16} />
        </li>
        <li className="mp-step">
          <span className="mp-step-label">
            <TargetIcon size={13} /> Alerts
          </span>
          <CallDots pct={callsPct} />
          <span className="mp-step-text">
            {callsPct !== null
              ? `About ${callsText(callsPct)} of every 100 chances${liveCallsPct ? ", at its cutoff now" : ""}`
              : p.goal === "team"
                ? "When its rule over the others is met"
                : "As many as its exam says still hit"}
          </span>
        </li>
      </ol>

      {p.waitsFor && (
        <p className="mp-wait">
          <ClockIcon size={14} /> Decides only once it has {p.waitsFor}.
        </p>
      )}
      {p.memoryDays !== null && <MemoryBar halfLifeDays={p.memoryDays} />}
    </section>
  );
}

const GOAL_ICON: Record<ModelProfile["goal"], (p: { size?: number }) => React.JSX.Element> = {
  "2x": TargetIcon,
  "4x": TargetIcon,
  "10x": TargetIcon,
  return: ChartIcon,
  safe: ShieldIcon,
  moonshot: RocketIcon,
  catch: RadarIcon,
  team: UsersIcon,
  rules: BookIcon,
};

/** "12", "35", or "2.5" for a slice under ten. */
export function callsText(pct: number): string {
  return pct < 10 ? String(Math.round(pct * 10) / 10) : String(Math.round(pct));
}

/** A hundred dots, the share it calls lit: how picky it is at a glance. */
export function CallDots({ pct }: { pct: number | null }) {
  const lit = pct === null ? 0 : Math.max(pct > 0 ? 1 : 0, Math.round(pct));
  return (
    <svg
      className="mp-dots"
      viewBox="0 0 100 25"
      role="img"
      aria-label={pct === null ? "No fixed share" : `${callsText(pct)} in 100`}
    >
      {Array.from({ length: 100 }, (_, i) => (
        <circle
          key={i}
          cx={(i % 20) * 5 + 2.5}
          cy={Math.floor(i / 20) * 5 + 2.5}
          r={1.7}
          className={i < lit ? "on" : "off"}
        />
      ))}
    </svg>
  );
}

/** What it reads, as signal bars: every bar for the whole picture, a few for a narrow view. */
function ReadsGlyph({ profile: p }: { profile: ModelProfile }) {
  // Which of eight signal groups it sees; the narrow views light the few they are built on.
  const lit: boolean[] =
    p.goal === "team" || p.goal === "rules"
      ? [true, false, true, false, true, false, true, false]
      : /few minutes|half hour/.test(p.reads)
        ? [true, true, true, false, false, false, false, false]
        : /story/i.test(p.reads)
          ? [false, false, false, false, true, true, true, true]
          : /except/.test(p.reads)
            ? [true, true, true, true, true, true, true, false]
            : Array<boolean>(8).fill(true);
  return (
    <svg className="mp-glyph" viewBox="0 0 80 40" aria-hidden>
      {lit.map((on, i) => (
        <rect
          key={i}
          x={4 + i * 9.5}
          y={34 - (12 + ((i * 7) % 18))}
          width={6}
          height={12 + ((i * 7) % 18)}
          rx={2}
          className={on ? "on" : "off"}
        />
      ))}
    </svg>
  );
}

/** A small picture of how it decides, one per method. */
export function MethodGlyph({ method }: { method: ModelProfile["method"] }) {
  return (
    <svg className="mp-glyph" viewBox="0 0 80 40" aria-hidden>
      {METHOD_SHAPES[method]}
    </svg>
  );
}

/** A tree from (x, y) down `depth` levels `dy` apart, `w` wide. */
function tree(x: number, y: number, w: number, depth: number, dy: number, key: string): React.JSX.Element[] {
  const out: React.JSX.Element[] = [];
  if (depth > 0) {
    for (const side of [-1, 1]) {
      const cx = x + (side * w) / 2;
      out.push(<line key={`${key}${side}l`} x1={x} y1={y} x2={cx} y2={y + dy} className="edge" />);
      out.push(...tree(cx, y + dy, w / 2, depth - 1, dy, `${key}${side}`));
    }
  }
  out.push(<circle key={`${key}n`} cx={x} cy={y} r={2.6} className="node" />);
  return out;
}

const METHOD_SHAPES: Record<ModelProfile["method"], React.JSX.Element> = {
  // Weights on a beam, summed into one score.
  formula: (
    <g>
      {[10, 22, 34, 46].map((x, i) => (
        <rect
          key={x}
          x={x}
          y={30 - [14, 22, 8, 18][i]!}
          width={7}
          height={[14, 22, 8, 18][i]!}
          rx={1.5}
          className="on"
        />
      ))}
      <path d="M56 20h8M60 16v8" className="edge" />
      <circle cx={72} cy={20} r={5} className="node" />
    </g>
  ),
  trees: <g>{tree(40, 7, 44, 2, 13, "t")}</g>,
  "deep-trees": <g>{tree(40, 5, 56, 3, 10, "d")}</g>,
  forest: (
    <g>
      {tree(14, 8, 18, 2, 12, "a")}
      {tree(40, 8, 18, 2, 12, "b")}
      {tree(66, 8, 18, 2, 12, "c")}
    </g>
  ),
  // Two gates in a row: dodge the drop, then double.
  "two-step": (
    <g>
      <path d="M4 20h14M30 20h18M60 20h16" className="edge" />
      <rect x={18} y={10} width={12} height={20} rx={3} className="on" />
      <rect x={48} y={10} width={12} height={20} rx={3} className="on" />
      <text x={24} y={38} className="lbl">
        safe?
      </text>
      <text x={54} y={38} className="lbl">
        2x?
      </text>
    </g>
  ),
  // A fitted line through scattered calls: it predicts the profit itself.
  regression: (
    <g>
      {[
        [10, 30],
        [18, 26],
        [26, 28],
        [34, 20],
        [42, 22],
        [50, 15],
        [58, 16],
        [66, 9],
      ].map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r={2} className="node" />
      ))}
      <path d="M6 32L72 6" className="edge strong" />
    </g>
  ),
  // A balance tipping toward the wins: the money won against the money lost.
  scales: (
    <g>
      <path d="M40 6v28M30 36h20" className="edge" />
      <path d="M12 20L68 12" className="edge strong" />
      <path d="M12 20l-7 12h14z" className="on" />
      <path d="M68 12l-7 12h14z" className="off" />
      <circle cx={40} cy={16} r={2.6} className="node" />
      <text x={12} y={39} className="lbl">
        won
      </text>
      <text x={68} y={39} className="lbl">
        lost
      </text>
    </g>
  ),
  // Many models feeding one.
  team: (
    <g>
      {[8, 20, 32].map((y) => (
        <g key={y}>
          <circle cx={10} cy={y} r={3.5} className="node" />
          <line x1={14} y1={y} x2={58} y2={20} className="edge" />
        </g>
      ))}
      <circle cx={64} cy={20} r={7} className="on" />
    </g>
  ),
  // A short checklist.
  rules: (
    <g>
      {[8, 20, 32].map((y) => (
        <g key={y}>
          <path d={`M14 ${y}l3 3 5-6`} className="edge strong" />
          <line x1={30} y1={y} x2={66} y2={y} className="edge" />
        </g>
      ))}
    </g>
  ),
  // The story and the safety check, weighed together.
  story: (
    <g>
      <rect x={6} y={8} width={22} height={24} rx={3} className="off" />
      <path d="M10 15h14M10 20h14M10 25h9" className="edge" />
      <path d="M58 8l12 4v8c0 7-6 11-12 13-6-2-12-6-12-13v-8z" className="on" />
      <path d="M30 20h14" className="edge strong" />
    </g>
  ),
};

/**
 * How long it remembers: how much a row counts by its age, fading by half every half-life, over
 * three half-lives (a week at least).
 */
export function MemoryBar({ halfLifeDays }: { halfLifeDays: number }) {
  const span = Math.max(7, Math.ceil(halfLifeDays * 3));
  const w = 560;
  const h = 80;
  const pts: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const age = (span * i) / 60;
    const weight = 0.5 ** (age / halfLifeDays);
    pts.push(`${(w - (age / span) * w).toFixed(1)},${(h - 6 - weight * (h - 12)).toFixed(1)}`);
  }
  const halfX = w - (halfLifeDays / span) * w;
  const days = Number.isInteger(halfLifeDays) ? String(halfLifeDays) : halfLifeDays.toFixed(1);
  const memory =
    halfLifeDays <= 4
      ? "Short memory: it bets the market is changing fast"
      : halfLifeDays >= 30
        ? "Long memory"
        : "Steady memory";
  return (
    <figure className="mp-memory">
      <figcaption>
        <strong>{memory}.</strong> What happened {days} day{halfLifeDays === 1 ? "" : "s"} ago counts half as
        much as today.
      </figcaption>
      <svg viewBox={`0 0 ${w} ${h + 16}`} role="img" aria-label={`Memory fades by half every ${days} days`}>
        <polygon points={`${w},${h - 6} ${pts.join(" ")} 0,${h - 6}`} className="mp-mem-area" />
        <polyline points={pts.join(" ")} className="mp-mem-line" />
        <line x1={halfX} y1={4} x2={halfX} y2={h - 6} className="mp-mem-half" />
        <text x={halfX} y={h + 12} className="lbl" style={{ textAnchor: "middle" }}>
          half
        </text>
        <text x={2} y={h + 12} className="lbl" style={{ textAnchor: "start" }}>
          {span} days ago
        </text>
        <text x={w - 2} y={h + 12} className="lbl" style={{ textAnchor: "end" }}>
          now
        </text>
      </svg>
    </figure>
  );
}
