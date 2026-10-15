import { useState } from "react";
import type { Leaderboard, MixCoverage } from "../api";
import { pct, signedPct } from "../format";
import { CheckIcon, PlusIcon, TargetIcon } from "./Icons";

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

function bestTitle(b: Best): string {
  return (
    `Add ${b.name} to your feed: ${plural(b.adds, "more runner")} caught` +
    (b.calls !== null ? ` for ${plural(b.calls, "more call")} in the window` : "") +
    (b.lift !== null ? `, its 2x rate ${b.lift.toFixed(1)}x the market's` : "") +
    (b.avgReturnPct !== null ? `, ${signedPct(b.avgReturnPct)} a call on average under the exit plan` : "") +
    ". Only models that beat the market and make money are suggested, the most runners per call first."
  );
}

function Track({ v, slim = false }: { v: CoverageView; slim?: boolean }) {
  return (
    <span className={`cov-track${slim ? " slim" : ""}`} aria-hidden>
      <span
        className={`cov-fill${v.early ? " early" : ""}${v.onGoal ? " on-goal" : ""}`}
        style={{ width: `${Math.min(100, Math.max(0, v.share))}%` }}
      />
      {!slim && v.field !== null && v.field > v.share && (
        <span className="cov-mark field" style={{ left: `${Math.min(100, v.field)}%` }} />
      )}
      <span className="cov-mark goal" style={{ left: `${Math.min(100, v.goal)}%` }} />
    </span>
  );
}

/**
 * The Coverage Meter on the Models tab: of the tokens that doubled in the window, the share the
 * models in this reader's feed would have caught between them, against the catch goal and against
 * every model together. One quiet row; the model that would lift it most is a tap away.
 */
export function CoverageMeter({
  board,
  onAdd,
  disabled = false,
  guest = false,
}: {
  board: Leaderboard;
  guest?: boolean;
  /** Adds a model to the feed; absent for guests, who can't pick. */
  onAdd?: (id: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = coverageView(board);
  if (!v) return null;
  const c = v.coverage;
  const days = board.window.days;
  const add = async (id: string) => {
    if (!onAdd) return;
    setAdding(id);
    setError(null);
    try {
      await onAdd(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(null);
    }
  };
  const title =
    `${coverageSentence(v, days, guest)} A runner counts as caught when any of your models called it at a ` +
    `winning moment. Goal ${v.goal}%` +
    (v.field !== null ? `; every model together caught ${pct(v.field)}.` : ".");

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
      <p className="cov-note muted small">
        {coverageSentence(v, days, guest)}
        {v.field !== null && c.runners > 0 && ` Every model together: ${pct(v.field)}.`}
        {v.early && c.runners > 0 && " Still early: too few runners to judge."}
      </p>
      {(v.members.length > 1 || v.best) && (
        <div className="cov-foot">
          {v.members.length > 1 && (
            <span className="cov-members faint small">
              {v.members.map((m, i) => (
                <span key={m.id}>
                  {i > 0 && " · "}
                  {m.name} <span className="num">{m.caught}</span>
                  {m.only > 0 && (
                    <span title={`Runners only ${m.name} caught among your models`}> ({m.only} only it)</span>
                  )}
                </span>
              ))}
            </span>
          )}
          {v.best &&
            (onAdd ? (
              <button
                type="button"
                className="cov-add"
                disabled={disabled || adding !== null}
                onClick={() => void add(v.best!.id)}
                title={bestTitle(v.best)}
              >
                <PlusIcon size={12} />
                {adding ? (
                  "Adding…"
                ) : (
                  <span>
                    {v.best.name} lifts it to {pct(v.best.pct)}
                    <span className="cov-add-cost">{bestCost(v.best)}</span>
                  </span>
                )}
              </button>
            ) : (
              <span className="faint small" title={bestTitle(v.best)}>
                Adding {v.best.name} would lift it to {pct(v.best.pct)} · {bestCost(v.best)}
              </span>
            ))}
        </div>
      )}
      {error && <small className="error">Couldn&apos;t add the model: {error}</small>}
    </div>
  );
}

/**
 * The meter as a chip, for the Live feed's header: the share and a slim bar. Opens the Models tab,
 * where the full meter and the switches are.
 */
export function CoverageChip({ board, onOpen }: { board: Leaderboard; onOpen: () => void }) {
  const v = coverageView(board);
  if (!v || v.coverage.runners === 0) return null;
  const c = v.coverage;
  return (
    <button
      type="button"
      className={`ghost cov-chip${v.early ? " early" : ""}`}
      onClick={onOpen}
      title={`Coverage: ${coverageSentence(v, board.window.days)} Goal ${v.goal}%. Tap to change your models.`}
      aria-label={`Coverage ${pct(c.pct)} of runners caught by your models. Open the Models tab.`}
    >
      <TargetIcon size={13} />
      <span className="num">{pct(c.pct)}</span>
      <Track v={v} slim />
    </button>
  );
}
