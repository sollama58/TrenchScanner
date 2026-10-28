import type { FeedMixRecord, Leaderboard, MixCoverage } from "../api";
import { pct, signedPct } from "../format";
import { intervalText, wilsonOfRate } from "../rates";
import { CheckIcon, TargetIcon } from "./Icons";

/** Runners below which the meter's share reads as early rather than as a verdict. */
export const MIN_RUNNERS_FOR_COVERAGE = 10;

/** The goal the meter is measured against when an older API build doesn't send one. */
const DEFAULT_GOAL_PCT = 75;

export interface CoverageView {
  coverage: MixCoverage;
  /** The share caught, 0-100 (0 while there are no runners). */
  share: number;
  goal: number;
  /** Every model together: the most any mix could reach. Null when the board doesn't send it. */
  field: number | null;
  early: boolean;
  onGoal: boolean;
  /** "Trees", "Trees + Survivor", "Trees +2". */
  label: string;
  /**
   * The model most worth adding (most runners added per call, among those that beat the market
   * and make money), by name, with the share it would reach and its record.
   */
  best: {
    id: string;
    name: string;
    pct: number;
    adds: number;
    calls: number | null;
    winRatePct: number | null;
    lift: number | null;
    avgReturnPct: number | null;
  } | null;
  /** Each model in the mix by name, most runners first. */
  members: { id: string; name: string; caught: number; only: number }[];
}

/** What the meter draws from a board, or null when the board has no coverage to show. */
export function coverageView(board: Leaderboard): CoverageView | null {
  const coverage = board.coverage;
  if (!coverage || coverage.models.length === 0) return null;
  const name = (id: string) => board.entries.find((e) => e.id === id)?.name ?? id;
  const names = coverage.models.map(name);
  const goal = board.scoring.catchTargetPct ?? DEFAULT_GOAL_PCT;
  const share = coverage.pct ?? 0;
  const top = coverage.additions[0];
  return {
    coverage,
    share,
    goal,
    field: board.runners?.pct ?? null,
    early: coverage.runners < MIN_RUNNERS_FOR_COVERAGE,
    onGoal: coverage.pct !== null && coverage.pct >= goal,
    label: names.length <= 2 ? names.join(" + ") : `${names[0]} +${names.length - 1}`,
    best: top
      ? {
          id: top.id,
          name: name(top.id),
          pct: top.pct,
          adds: top.adds ?? top.caught - coverage.caught,
          calls: top.calls ?? null,
          winRatePct: top.winRatePct ?? null,
          lift: top.lift ?? null,
          avgReturnPct: top.avgReturnPct ?? null,
        }
      : null,
    members: coverage.members
      .map((m) => ({ ...m, name: name(m.id) }))
      .sort((a, b) => b.caught - a.caught || a.name.localeCompare(b.name)),
  };
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** The meter's sentence: what the mix caught, of what, over which window. */
export function coverageSentence(v: CoverageView, days: number, guest = false): string {
  const c = v.coverage;
  const who =
    c.models.length === 1
      ? v.label
      : guest
        ? `The guest feed's ${c.models.length} models together`
        : `Your ${c.models.length} models together`;
  if (c.runners === 0) return `No runners in the last ${plural(days, "day")} yet.`;
  return `${who} would have caught ${c.caught.toLocaleString()} of the ${plural(c.runners, "runner")} (tokens that doubled) in the last ${plural(days, "day")}.`;
}

type Best = NonNullable<CoverageView["best"]>;

/** What the suggested model brings: the runners it adds, and the hit rate and return of its calls. */
export function bestCost(b: Best): string {
  const parts = [`+${plural(b.adds, "runner")}`];
  if (b.winRatePct !== null) parts.push(`${pct(b.winRatePct)} hit 2x`);
  if (b.avgReturnPct !== null) parts.push(`${signedPct(b.avgReturnPct)} avg return`);
  return parts.join(" · ");
}

/** The 10x rate's goal when an older API build doesn't send one (as the chart). */
const DEFAULT_TEN_X_GOAL_PCT = 25;

/** The average return the profit row's track spans either side of break-even, in percent. */
export const PROFIT_SPAN_PCT = 50;

export interface MixRate {
  id: "2x" | "4x" | "10x" | "profit";
  label: string;
  /** The rate (or, for profit, the average return per call), in percent; null with nothing graded. */
  value: number | null;
  /** The goal line: the target rate, or break-even (0) for profit. */
  goal: number;
  /** Where the fill ends and the goal sits on the track, 0-100. */
  fill: number;
  mark: number;
  onGoal: boolean;
}

/**
 * The combined record under the meter: the models' 2x, 4x and 10x rates and average return,
 * pooled as one feed (each coin once, at its earliest alert). Null when the board doesn't send one.
 */
export function mixRates(board: Leaderboard): { mix: FeedMixRecord; rates: MixRate[] } | null {
  const mix = board.mix;
  if (!mix || mix.models.length === 0) return null;
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  const rate = (id: MixRate["id"], label: string, value: number | null, goal: number): MixRate => ({
    id,
    label,
    value,
    goal,
    fill: clamp(value ?? 0),
    mark: clamp(goal),
    onGoal: value !== null && value >= goal,
  });
  const ret = mix.avgReturnPct;
  // Profit is centred on break-even: the fill grows right for a gain and left for a loss.
  const profitAt = (n: number) => clamp(50 + (n / PROFIT_SPAN_PCT) * 50);
  return {
    mix,
    rates: [
      rate("2x", "2x", mix.hitRate2xPct, board.targets.hitRate2xPct),
      rate("4x", "4x", mix.hitRate4xPct, board.targets.hitRate4xPct),
      rate("10x", "10x", mix.hitRate10xPct, board.scoring.tenXTargetPct ?? DEFAULT_TEN_X_GOAL_PCT),
      {
        id: "profit",
        label: "Profit",
        value: ret,
        goal: 0,
        fill: ret === null ? 50 : profitAt(ret),
        mark: 50,
        onGoal: ret !== null && ret > 0,
      },
    ],
  };
}

/** The combined 2x / 4x / 10x rates and average return of the meter's models, one row each. */
function MixRates({ board }: { board: Leaderboard }) {
  const m = mixRates(board);
  if (!m) return null;
  const { mix, rates } = m;
  const early = mix.graded < MIN_RUNNERS_FOR_COVERAGE;
  return (
    <div className="cov-mix">
      {rates.map((r) => {
        const profit = r.id === "profit";
        const text = profit ? signedPct(r.value, 1) : pct(r.value, 1);
        // A pooled rate on its own sample reads surer than it is: its 90% range (audit 10-27 WB-25).
        const range = profit ? "" : intervalText(wilsonOfRate(r.value, mix.graded));
        const left = profit ? Math.min(r.fill, 50) : 0;
        const width = profit ? Math.abs(r.fill - 50) : r.fill;
        return (
          <div className="cov-mix-row" key={r.id}>
            <span className="cov-mix-label muted small">{r.label}</span>
            <span className="cov-track sm" aria-hidden>
              <span
                className={`cov-fill${early ? " early" : ""}${r.onGoal ? " on-goal" : ""}${
                  profit && r.value !== null && r.value < 0 ? " loss" : ""
                }`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
              <span className="cov-mark goal" style={{ left: `${r.mark}%` }} />
            </span>
            <span
              className={`cov-mix-value num small${early ? " early" : ""}`}
              role="meter"
              aria-label={profit ? "Combined average return per alert" : `Combined ${r.label} hit rate`}
              aria-valuemin={profit ? -PROFIT_SPAN_PCT : 0}
              aria-valuemax={profit ? PROFIT_SPAN_PCT : 100}
              aria-valuenow={r.value ?? 0}
              aria-valuetext={r.value === null ? "nothing graded yet" : range ? `${text}, ${range}` : text}
              title={range || undefined}
            >
              {text}
            </span>
            <span className="cov-mix-goal faint small num">{profit ? "break-even" : `goal ${r.goal}%`}</span>
          </div>
        );
      })}
      <p className="cov-note faint small">
        {mix.models.length === 1 ? "This model's" : `These ${mix.models.length} models'`} alerts as one feed:
        each coin counts once, at the first alert any of them sent on it ({mix.graded.toLocaleString()} graded
        {early && mix.graded > 0 ? ", still early" : ""}). Hover a rate for its 90% range. Profit is the
        average return per alert under the exit plan.
      </p>
    </div>
  );
}

function Track({ v }: { v: CoverageView }) {
  return (
    <span className="cov-track" aria-hidden>
      <span
        className={`cov-fill${v.early ? " early" : ""}${v.onGoal ? " on-goal" : ""}`}
        style={{ width: `${Math.min(100, Math.max(0, v.share))}%` }}
      />
      {v.field !== null && v.field > v.share && (
        <span className="cov-mark field" style={{ left: `${Math.min(100, v.field)}%` }} />
      )}
      <span className="cov-mark goal" style={{ left: `${Math.min(100, v.goal)}%` }} />
    </span>
  );
}

/**
 * The Coverage Meter on the Models tab: of the tokens that doubled in the window, the share the
 * models in this reader's feed would have caught between them, against the catch goal and against
 * every model together. One quiet row; the model that would lift it most is marked on the board.
 */
export function CoverageMeter({ board, guest = false }: { board: Leaderboard; guest?: boolean }) {
  const v = coverageView(board);
  if (!v) return null;
  const c = v.coverage;
  const days = board.window.days;
  const title =
    `${coverageSentence(v, days, guest)} A runner counts as caught when any of your models flagged it at a ` +
    `winning moment. Goal ${v.goal}%` +
    (v.field !== null ? `; every model together caught ${pct(v.field)}.` : ".") +
    (v.early && c.runners > 0 ? " Still early: too few runners to judge." : "");

  return (
    <div className="coverage" title={title}>
      <div className="cov-head">
        <span className="cov-label">
          <TargetIcon size={13} /> Coverage
        </span>
        <span
          className={`cov-value num${v.early ? " early" : ""}`}
          role="meter"
          aria-label="Share of runners your models would have caught"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={c.pct ?? 0}
          aria-valuetext={c.pct === null ? "no runners yet" : `${pct(c.pct)} of runners caught`}
        >
          {c.pct === null ? "–" : pct(c.pct)}
        </span>
        <Track v={v} />
        {v.onGoal && !v.early ? (
          <span className="cov-badge">
            <CheckIcon size={12} /> On goal
          </span>
        ) : (
          <span className="cov-goal muted small num">goal {v.goal}%</span>
        )}
      </div>
      <p className="cov-note faint small">
        Coverage is the share of all tracked runners (tokens that doubled) your combined model picks would
        have caught.
        {v.field !== null &&
          v.field > v.share &&
          " The dot is every model together, the most any mix could catch."}
        {` The line is the ${v.goal}% goal.`}
      </p>
      <MixRates board={board} />
    </div>
  );
}
