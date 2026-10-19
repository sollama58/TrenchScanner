import {
  prisma,
  Prisma,
  recordScore,
  walletSafetyCutsSql,
  firstCallOnRowSql,
  notRetiredModelSql,
  REPORTED_LABEL_RULE,
  type PrecisionTargets,
  marketRowWon,
  type MarketRow,
} from "@trenchscanner/core";
import { marketCounts, type MarketRowSource } from "./marketRows.js";
import { MIN_GRADED_FOR_VERDICT, type GradedCounts, type Targets } from "./routes/stats.js";

/**
 * Is the system getting better as data accumulates? The Models tab's learning curve: two series
 * a reader can compare day over day, and the honest way to compare them.
 *
 * The leaderboard's score cannot answer that question on its own. It pools a model's calls over a
 * window and shrinks the phantom-miss prior as evidence arrives, so it rises for weeks with no
 * change in skill. The hit rate alone cannot either: on a day the whole market doubles twice as
 * often, every model looks twice as good. What does carry across days is LIFT - the feed's 2x rate
 * divided by the 2x rate of the moments the models decided on that day (the "event" training rows,
 * see CandidateOutcome.sampleKind). A model that learns is a model whose lift climbs; a model that
 * only rides the market has a flat lift and a hit rate that moves with the base rate.
 *
 * The same holds for the training runs: each run's walk-forward exam reports its hit rate at the
 * cutoff AND the base rate of the decision moments it graded, so a run's exam lift is comparable
 * with the last run's even though the exam window moved.
 */

/** Fewest graded calls on a side before a day's lift is shown - a 2-of-3 day is noise. */
export const MIN_GRADED_FOR_LIFT = 10;

/** How many days each side of the trend verdict pools. */
export const TREND_SPAN_DAYS = 7;

/** A 2x lift change smaller than this between the two trend spans reads as flat. */
export const TREND_FLAT_BAND = 0.2;
/** The same for the 4x lift - a rarer tier, so a noisier ratio. */
export const TREND_FLAT_BAND_4X = 0.3;
/** The same for the return edge (feed avg return minus the market's), in percentage points. */
export const TREND_FLAT_BAND_RETURN_PTS = 2;

/** Every run of a short window, one run a day (its last) of a longer one. */
const EVERY_RUN_UP_TO_DAYS = 7;
const MAX_RUNS = 120;
/** Distinct run stamps read before thinning - 90 days at twelve runs a day. */
const MAX_RUN_STAMPS = 1_200;

/** Pure: the runs to show out of the distinct run stamps (any order), newest first. */
export function chooseRuns(stamps: readonly Date[], everyRun: boolean): Date[] {
  const sorted = [...stamps].sort((a, b) => b.getTime() - a.getTime());
  if (everyRun) return sorted.slice(0, MAX_RUNS);
  const seen = new Set<string>();
  const out: Date[] = [];
  for (const d of sorted) {
    const day = d.toISOString().slice(0, 10);
    if (seen.has(day)) continue;
    seen.add(day);
    out.push(d);
    if (out.length >= MAX_RUNS) break;
  }
  return out;
}

export interface DayRates extends GradedCounts {
  rate2xPct: number | null;
  rate4xPct: number | null;
  /** won10x over the calls whose 10x tier has settled (tenXGraded). */
  rate10xPct: number | null;
  /** Average simulated return per call under the fixed exit plan (sumSimReturnPct / simCalls), in percent. */
  avgReturnPct: number | null;
  /**
   * Catch (absent from the market side): the day's runners - distinct tokens with a clean 2x from a
   * market moment or any call that day, as liveCatch counts them - and how many of them these calls
   * caught at a winning moment, with the share in percent (null with no runners).
   */
  runners?: number;
  caught?: number;
  catchPct?: number | null;
}

export interface LearningDay {
  /** Calendar day in the curve's zone (LearningCurve.timeZone; UTC unless a reader's), YYYY-MM-DD. */
  day: string;
  /** The decision moments the models saw that day: graded "event" rows under a reported label rule (REPORTED_LABEL_RULE). */
  market: DayRates;
  /** Every model's calls that day, pooled, graded by the same rule. */
  feed: DayRates;
  /** feed 2x rate / market 2x rate; null when either side has under MIN_GRADED_FOR_LIFT graded. */
  lift2x: number | null;
  lift4x: number | null;
  /** The same for the 10x tier, over each side's settled calls. */
  lift10x: number | null;
}

export interface LearningRunModel {
  contestant: string;
  name: string | null;
  /** The exam's governed calls and record (StoredEvalMetrics.exam). */
  calls: number;
  wins: number;
  goals: number;
  /** Exam calls that reached 10x within an hour; null on exams stored before it was counted. */
  tenX: number | null;
  rate2xPct: number | null;
  rate4xPct: number | null;
  rate10xPct: number | null;
  /** The exam's lift over the run's base rate. */
  lift2x: number | null;
  /** The leaderboard's score of that exam record alone, 0-100. */
  score: number | null;
}

export interface LearningRun {
  /** When the run finished (CuratorModel.trainingTo). */
  at: string;
  trainingRows: number;
  /** Days of history the run trained on (trainingTo - trainingFrom). */
  historyDays: number;
  /** The decision moments the exam graded, summed over its folds, and their base 2x rate. */
  exam: { decisionRows: number; decisionWins: number; baseRate2xPct: number | null };
  models: LearningRunModel[];
  /** The model with the best exam 2x rate this run (at least MIN_GRADED_FOR_LIFT exam calls). */
  best: LearningRunModel | null;
}

export interface LearningTrendSpan {
  from: string;
  to: string;
  feed: DayRates;
  market: DayRates;
  lift2x: number | null;
  lift4x: number | null;
  lift10x: number | null;
  /** Feed avg simulated return minus the market's, in percentage points; null when either is unknown. */
  returnEdgePts: number | null;
}

export interface LearningTrend {
  /** The newest TREND_SPAN_DAYS days with any graded feed calls, pooled. */
  recent: LearningTrendSpan;
  /** The TREND_SPAN_DAYS days before them, pooled. */
  prior: LearningTrendSpan | null;
  /**
   * improving / flat / worsening when both spans hold MIN_GRADED_FOR_VERDICT graded feed calls and
   * a 2x lift; too-early otherwise. The verdict weighs the whole scorecard, not the 2x lift alone:
   * the 2x lift, the 4x lift and the return edge each vote up, down or flat (past their own band),
   * and the sum decides. The 10x lift is reported but too thin to vote.
   */
  verdict: "improving" | "flat" | "worsening" | "too-early";
  reason: string;
}

/** One model's day: its own calls, graded like the feed's, and their lift over that day's market. */
export interface LearningModelDay {
  day: string;
  rates: DayRates;
  lift2x: number | null;
}

/**
 * One model's learning curve: its calls by day (only days it called on; the market for each day is
 * the curve's own `days`), and the same two-span trend verdict the feed gets.
 */
export interface LearningModel {
  /** The contestant id (CuratedAlert.model) - the seat, stable across the names it has held. */
  model: string;
  /** The name it called under most recently in the window. */
  name: string | null;
  days: LearningModelDay[];
  trend: LearningTrend | null;
}

export interface LearningCurve {
  window: { since: string; until: string };
  /** The zone whose calendar days `days` are (UTC unless a reader's was asked for). */
  timeZone: string;
  /** Oldest first. Days with neither a decision moment nor a call are left out. */
  days: LearningDay[];
  /** Each model's own curve against the same market, most graded calls first. */
  models: LearningModel[];
  /** Newest first. Every run of a window up to EVERY_RUN_UP_TO_DAYS days, else each day's last run. */
  runs: LearningRun[];
  trend: LearningTrend | null;
  minGradedForLift: number;
  trendSpanDays: number;
  note: string;
}

type RawDay = {
  day: string;
  calls: bigint;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  won10x: bigint;
  ten_x_graded: bigint;
  doubled_after_stop: bigint;
  /** Calls with a simulated return, and its sum in percent; absent from older fixtures. */
  sim_calls?: bigint;
  sim_sum?: number | null;
  /** Of sim_calls, the open ones (priced at the latest reading); absent from older fixtures. */
  sim_open?: bigint;
};

type RawModelDay = RawDay & { model: string | null; model_name: string | null };

type RawRun = {
  at: Date;
  contestant: string;
  name: string | null;
  training_rows: number;
  training_from: Date;
  calls: number | null;
  wins: number | null;
  goals: number | null;
  ten_x: number | null;
  ten_x_graded: number | null;
  sum_label: number | null;
  decision_rows: number | null;
  decision_wins: number | null;
};

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

function ratio(a: number, aN: number, b: number, bN: number, min: number): number | null {
  if (aN < min || bN < min || b === 0) return null;
  return Math.round((a / aN / (b / bN)) * 100) / 100;
}

function dayRates(r: RawDay | undefined): DayRates {
  const c: GradedCounts = {
    calls: Number(r?.calls ?? 0),
    graded: Number(r?.graded ?? 0),
    won2x: Number(r?.won2x ?? 0),
    won4x: Number(r?.won4x ?? 0),
    won10x: Number(r?.won10x ?? 0),
    tenXGraded: Number(r?.ten_x_graded ?? 0),
    doubledAfterStop: Number(r?.doubled_after_stop ?? 0),
    simCalls: Number(r?.sim_calls ?? 0),
    sumSimReturnPct: Number(r?.sim_sum ?? 0),
    simOpen: Number(r?.sim_open ?? 0),
  };
  return withDayRates(c);
}

function withDayRates(c: GradedCounts): DayRates {
  return {
    ...c,
    rate2xPct: pct(c.won2x, c.graded),
    rate4xPct: pct(c.won4x, c.graded),
    rate10xPct: pct(c.won10x ?? 0, c.tenXGraded ?? 0),
    avgReturnPct: c.simCalls ? Math.round(((c.sumSimReturnPct ?? 0) / c.simCalls) * 10) / 10 : null,
  };
}

function sumDays(rows: DayRates[]): DayRates {
  const c = rows.reduce<GradedCounts>(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      graded: acc.graded + r.graded,
      won2x: acc.won2x + r.won2x,
      won4x: acc.won4x + r.won4x,
      won10x: (acc.won10x ?? 0) + (r.won10x ?? 0),
      tenXGraded: (acc.tenXGraded ?? 0) + (r.tenXGraded ?? 0),
      doubledAfterStop: acc.doubledAfterStop + r.doubledAfterStop,
      simCalls: (acc.simCalls ?? 0) + (r.simCalls ?? 0),
      sumSimReturnPct: (acc.sumSimReturnPct ?? 0) + (r.sumSimReturnPct ?? 0),
      simOpen: (acc.simOpen ?? 0) + (r.simOpen ?? 0),
    }),
    {
      calls: 0,
      graded: 0,
      won2x: 0,
      won4x: 0,
      won10x: 0,
      tenXGraded: 0,
      doubledAfterStop: 0,
      simCalls: 0,
      sumSimReturnPct: 0,
      simOpen: 0,
    },
  );
  return withDayRates(c);
}

function liftOf(feed: DayRates, market: DayRates, min = MIN_GRADED_FOR_LIFT): number | null {
  return ratio(feed.won2x, feed.graded, market.won2x, market.graded, min);
}

/** Pure: the day series from the two raw day tables, oldest first. */
export function buildLearningDays(marketRows: RawDay[], feedRows: RawDay[]): LearningDay[] {
  const market = new Map(marketRows.map((r) => [r.day, r]));
  const feed = new Map(feedRows.map((r) => [r.day, r]));
  const days = [...new Set([...market.keys(), ...feed.keys()])].sort();
  return days.map((day) => {
    const m = dayRates(market.get(day));
    const f = dayRates(feed.get(day));
    return {
      day,
      market: m,
      feed: f,
      lift2x: liftOf(f, m),
      lift4x: ratio(f.won4x, f.graded, m.won4x, m.graded, MIN_GRADED_FOR_LIFT),
      lift10x: ratio(f.won10x ?? 0, f.tenXGraded ?? 0, m.won10x ?? 0, m.tenXGraded ?? 0, MIN_GRADED_FOR_LIFT),
    };
  });
}

/**
 * Pure: each model's curve from the per-model day rows, against the market rows. Rows without a
 * model (calls from before the contest) count toward the feed only. Most graded calls first.
 */
export function buildLearningModels(marketRows: RawDay[], rows: RawModelDay[]): LearningModel[] {
  const byModel = new Map<string, RawModelDay[]>();
  for (const r of rows) {
    if (!r.model) continue;
    const list = byModel.get(r.model);
    if (list) list.push(r);
    else byModel.set(r.model, [r]);
  }
  const gradedOf = (m: LearningModel) => m.days.reduce((n, d) => n + d.rates.graded, 0);
  return [...byModel.entries()]
    .map(([model, own]) => {
      const days = buildLearningDays(marketRows, own);
      const newestFirst = [...own].sort((a, b) => b.day.localeCompare(a.day));
      return {
        model,
        name: newestFirst.find((r) => r.model_name)?.model_name ?? null,
        days: days
          .filter((d) => d.feed.calls > 0)
          .map((d) => ({ day: d.day, rates: d.feed, lift2x: d.lift2x })),
        trend: buildLearningTrend(days),
      };
    })
    .sort((a, b) => gradedOf(b) - gradedOf(a) || a.model.localeCompare(b.model));
}

/**
 * Pure: the trend verdict. The newest span is the last TREND_SPAN_DAYS calendar days that had a
 * graded call; the prior span the TREND_SPAN_DAYS days before those. Both need a lift and
 * MIN_GRADED_FOR_VERDICT graded calls for a verdict - fewer and the honest answer is "too early".
 */
export function buildLearningTrend(days: LearningDay[]): LearningTrend | null {
  const graded = days.filter((d) => d.feed.graded > 0);
  if (graded.length === 0) return null;
  const lastDay = graded[graded.length - 1]!.day;
  const dayMs = 86_400_000;
  const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const recentFrom = toMs(lastDay) - (TREND_SPAN_DAYS - 1) * dayMs;
  const priorFrom = recentFrom - TREND_SPAN_DAYS * dayMs;
  const inSpan = (from: number, to: number) => days.filter((d) => toMs(d.day) >= from && toMs(d.day) <= to);
  const pool = (rows: LearningDay[], from: number, to: number) => {
    const feed = sumDays(rows.map((d) => d.feed));
    const market = sumDays(rows.map((d) => d.market));
    const edge =
      feed.avgReturnPct !== null && market.avgReturnPct !== null
        ? Math.round((feed.avgReturnPct - market.avgReturnPct) * 10) / 10
        : null;
    return {
      from: toDay(from),
      to: toDay(to),
      feed,
      market,
      lift2x: liftOf(feed, market),
      lift4x: ratio(feed.won4x, feed.graded, market.won4x, market.graded, MIN_GRADED_FOR_LIFT),
      lift10x: ratio(
        feed.won10x ?? 0,
        feed.tenXGraded ?? 0,
        market.won10x ?? 0,
        market.tenXGraded ?? 0,
        MIN_GRADED_FOR_LIFT,
      ),
      returnEdgePts: edge,
    };
  };
  const recent = pool(inSpan(recentFrom, toMs(lastDay)), recentFrom, toMs(lastDay));
  const priorRows = inSpan(priorFrom, recentFrom - dayMs);
  const prior = priorRows.length > 0 ? pool(priorRows, priorFrom, recentFrom - dayMs) : null;

  let verdict: LearningTrend["verdict"] = "too-early";
  let reason: string;
  if (recent.lift2x === null || recent.feed.graded < MIN_GRADED_FOR_VERDICT) {
    reason = `Fewer than ${MIN_GRADED_FOR_VERDICT} graded alerts in the last ${TREND_SPAN_DAYS} days - no verdict yet.`;
  } else if (!prior || prior.lift2x === null || prior.feed.graded < MIN_GRADED_FOR_VERDICT) {
    reason = `The last ${TREND_SPAN_DAYS} days hold a lift of ${recent.lift2x.toFixed(2)}x over the filtered market; the ${TREND_SPAN_DAYS} before them have too few graded alerts to compare.`;
  } else {
    const lines: {
      label: string;
      before: number | null;
      after: number | null;
      band: number;
      fmt: (v: number) => string;
    }[] = [
      {
        label: "2x lift",
        before: prior.lift2x,
        after: recent.lift2x,
        band: TREND_FLAT_BAND,
        fmt: (v) => `${v.toFixed(2)}x`,
      },
      {
        label: "4x lift",
        before: prior.lift4x,
        after: recent.lift4x,
        band: TREND_FLAT_BAND_4X,
        fmt: (v) => `${v.toFixed(2)}x`,
      },
      {
        label: "return edge",
        before: prior.returnEdgePts,
        after: recent.returnEdgePts,
        band: TREND_FLAT_BAND_RETURN_PTS,
        fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} pts`,
      },
    ];
    let votes = 0;
    const said: string[] = [];
    for (const l of lines) {
      if (l.before === null || l.after === null) continue;
      const delta = l.after - l.before;
      votes += delta > l.band ? 1 : delta < -l.band ? -1 : 0;
      said.push(`${l.label} ${l.fmt(l.before)} to ${l.fmt(l.after)}`);
    }
    verdict = votes > 0 ? "improving" : votes < 0 ? "worsening" : "flat";
    reason = `Against the filtered market between the two ${TREND_SPAN_DAYS}-day spans: ${said.join(", ")} (${
      recent.feed.graded
    } graded alerts lately, ${prior.feed.graded} before).`;
  }
  return { recent, prior, verdict, reason };
}

/** Pure: the per-run series from the raw model rows (any order), newest run first. */
export function buildLearningRuns(rows: RawRun[], targets: PrecisionTargets): LearningRun[] {
  const byRun = new Map<number, RawRun[]>();
  for (const r of rows) {
    const key = r.at.getTime();
    const list = byRun.get(key);
    if (list) list.push(r);
    else byRun.set(key, [r]);
  }
  return [...byRun.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([atMs, models]) => {
      const first = models[0]!;
      // Every learner's exam cut the same folds; the rules row carries the same folds under the
      // heuristic side. The stacked and blend rows have none. Take the largest count seen.
      const decisionRows = Math.max(0, ...models.map((m) => m.decision_rows ?? 0));
      const decisionWins = Math.max(0, ...models.map((m) => m.decision_wins ?? 0));
      const baseRate2xPct = pct(decisionWins, decisionRows);
      const entries: LearningRunModel[] = models
        .map((m) => {
          const calls = m.calls ?? 0;
          const wins = m.wins ?? 0;
          const goals = m.goals ?? 0;
          const tenX = m.ten_x;
          const tenXGraded = tenX === null ? null : (m.ten_x_graded ?? calls);
          return {
            contestant: m.contestant,
            name: m.name,
            calls,
            wins,
            goals,
            tenX,
            rate2xPct: pct(wins, calls),
            rate4xPct: pct(goals, calls),
            rate10xPct: tenX === null || tenXGraded === null ? null : pct(tenX, tenXGraded),
            lift2x: ratio(wins, calls, decisionWins, decisionRows, MIN_GRADED_FOR_LIFT),
            score:
              calls > 0
                ? recordScore(
                    {
                      calls,
                      graded: calls,
                      wins,
                      goals,
                      sumLabel: m.sum_label ?? 0,
                      ...(tenX !== null ? { tenX, ...(tenXGraded !== null ? { tenXGraded } : {}) } : {}),
                    },
                    targets,
                  )
                : null,
          };
        })
        .sort((a, b) => (b.rate2xPct ?? -1) - (a.rate2xPct ?? -1));
      const best = entries.find((e) => e.calls >= MIN_GRADED_FOR_LIFT) ?? null;
      return {
        at: new Date(atMs).toISOString(),
        trainingRows: first.training_rows,
        historyDays: Math.round(((atMs - first.training_from.getTime()) / 86_400_000) * 10) / 10,
        exam: { decisionRows, decisionWins, baseRate2xPct },
        models: entries,
        best,
      };
    });
}

/** A clean double on a UTC day: a market moment's token, or a call's (with the model that made it). */
export type DayWinner = { day: string; token: string; model?: string | null };

/** Pure: the runners each day (distinct tokens with a clean 2x from a market moment or any call). */
export function runnersByDay(market: readonly DayWinner[], calls: readonly DayWinner[]): Map<string, number> {
  const tokens = new Map<string, Set<string>>();
  for (const w of [...market, ...calls]) {
    let set = tokens.get(w.day);
    if (!set) tokens.set(w.day, (set = new Set()));
    set.add(w.token);
  }
  return new Map([...tokens].map(([day, set]) => [day, set.size]));
}

/** Pure: distinct tokens caught each day by the given calls (any model's when `model` is omitted). */
export function caughtByDay(calls: readonly DayWinner[], model?: string): Map<string, number> {
  const tokens = new Map<string, Set<string>>();
  for (const w of calls) {
    if (model !== undefined && w.model !== model) continue;
    let set = tokens.get(w.day);
    if (!set) tokens.set(w.day, (set = new Set()));
    set.add(w.token);
  }
  return new Map([...tokens].map(([day, set]) => [day, set.size]));
}

/** Pure: a day's rates with its catch added. */
export function withCatch(rates: DayRates, runners: number, caught: number): DayRates {
  return { ...rates, runners, caught, catchPct: pct(caught, runners) };
}

/** Formatters by zone: en-CA writes a date as YYYY-MM-DD. Bounded by the zones callers validate. */
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** Pure: the calendar day `at` falls on in `timeZone`, as YYYY-MM-DD. */
export function dayIn(at: Date, timeZone: string): string {
  if (timeZone === "UTC") return at.toISOString().slice(0, 10);
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormats.set(timeZone, format);
  }
  return format.format(at);
}

/** The market line's day rows from shared market rows: the same columns its query returns. */
function marketDays(rows: readonly MarketRow[], timeZone: string): RawDay[] {
  const byDay = new Map<string, MarketRow[]>();
  for (const r of rows) {
    const day = dayIn(r.at, timeZone);
    const list = byDay.get(day);
    if (list) list.push(r);
    else byDay.set(day, [r]);
  }
  return [...byDay].map(([day, list]) => ({ day, ...marketCounts(list) }));
}

/** The market's clean doubles by day from shared market rows: the same as readMarketWinners. */
function marketDayWinners(rows: readonly MarketRow[], timeZone: string): DayWinner[] {
  return rows.filter(marketRowWon).map((r) => ({ day: dayIn(r.at, timeZone), token: r.token }));
}

export async function buildLearningCurve(
  since: Date,
  until: Date,
  targets: Targets,
  days: number,
  /** Shared market rows (marketRows.ts); without them, or past their span, the market is read here. */
  marketSource?: MarketRowSource,
  /**
   * The zone the days are calendar days in: the reader's, so "Today" is their today (user ask
   * 2026-10-19). A name Postgres knows (callers check, see readerZone.ts), UTC by default.
   */
  timeZone = "UTC",
): Promise<LearningCurve> {
  // The trend compares the newest TREND_SPAN_DAYS days with the TREND_SPAN_DAYS before them, so
  // the day reads reach back two spans even when the window is shorter. Reading only the window
  // left a 7-day window's "prior" span as the oldest day's last few hours (288 graded calls
  // against 13,534), and the verdict said "worsening" off that sliver. Days outside the window
  // feed the trend only; the series below is cut back to the window.
  const trendSince = new Date(
    Math.min(
      since.getTime(),
      Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()) -
        // A day more than the two spans when the days are another zone's, whose midnight can
        // fall up to a day either side of UTC's.
        (2 * TREND_SPAN_DAYS - (timeZone === "UTC" ? 1 : 0)) * 86_400_000,
    ),
  );
  // The columns are timestamp(3) without a zone, stored in UTC: read as UTC, then as the zone's
  // wall clock, date_trunc groups by the zone's calendar day.
  const dayOf = (col: Prisma.Sql) =>
    Prisma.sql`to_char(date_trunc('day', (${col} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}), 'YYYY-MM-DD')`;
  const anchorDay = dayOf(Prisma.sql`"anchorAt"`);
  const createdDay = dayOf(Prisma.sql`a."createdAt"`);
  // Decision moments by day. Only current-rule labels: rows graded from the scan price answer
  // an easier question (about twice the base rate), and a day of them next to a day of fill-graded
  // rows would read as the market halving.
  const readMarket = () => prisma.$queryRaw<RawDay[]>`
    SELECT ${anchorDay} AS day,
           count(*) AS calls,
           count(*) FILTER (WHERE "hit2xIn1h" IS NOT NULL) AS graded,
           count(*) FILTER (WHERE "hit2xIn1h" AND NOT COALESCE("disqualified", false)) AS won2x,
           count(*) FILTER (WHERE "hit4xIn1h") AS won4x,
           count(*) FILTER (WHERE "hit10xIn1h") AS won10x,
           count(*) FILTER (WHERE "hit2xIn1h" IS NOT NULL
                              AND ("hit10xIn1h" IS NOT NULL
                                   OR NOT ("hit2xIn1h" AND NOT COALESCE("disqualified", false)))) AS ten_x_graded,
           count(*) FILTER (WHERE "disqualified") AS doubled_after_stop,
           count(COALESCE("simReturnPct", "openReturnPct")) FILTER (WHERE "hit2xIn1h" IS NOT NULL) AS sim_calls,
           sum(COALESCE("simReturnPct", "openReturnPct")) FILTER (WHERE "hit2xIn1h" IS NOT NULL)::float8 AS sim_sum,
           count("openReturnPct") FILTER (WHERE "hit2xIn1h" IS NOT NULL AND "simReturnPct" IS NULL) AS sim_open
    FROM "CandidateOutcome"
    WHERE "sampleKind" = 'event'
      AND "anchorAt" >= ${trendSince} AND "anchorAt" < ${until}
      AND ${walletSafetyCutsSql()}
      AND "labelRule" >= ${REPORTED_LABEL_RULE}
    GROUP BY 1`;
  // The market's clean doubles by day: the runners a catch is measured against (liveCatch's rule).
  const readMarketWinners = () => prisma.$queryRaw<DayWinner[]>`
    SELECT DISTINCT ${anchorDay} AS day, "tokenId" AS token
    FROM "CandidateOutcome"
    WHERE "sampleKind" = 'event'
      AND "anchorAt" >= ${since} AND "anchorAt" < ${until}
      AND "hit2xIn1h" AND NOT COALESCE("disqualified", false)
      AND ${walletSafetyCutsSql()}
      AND "labelRule" >= ${REPORTED_LABEL_RULE}`;
  const heldMarket = marketSource ? marketSource(trendSince) : Promise.resolve(null);
  const marketRows: Promise<RawDay[]> = heldMarket.then((held) =>
    held
      ? marketDays(
          held.filter((r) => r.at < until),
          timeZone,
        )
      : readMarket(),
  );
  const marketWinners: Promise<DayWinner[]> = heldMarket.then((held) =>
    held
      ? marketDayWinners(
          held.filter((r) => r.at >= since && r.at < until),
          timeZone,
        )
      : readMarketWinners(),
  );
  // Every model's calls by day, graded the same way (see buildHitRateReport for the label
  // sources). A call whose training row was graded under the legacy rule is left out for the same
  // reason as above; one whose row is gone keeps its own copied verdict.
  const callCols = Prisma.sql`
           count(*) AS calls,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS graded,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h")
                              AND NOT COALESCE(a."disqualified", co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE COALESCE(a."hit4xIn1h", co."hit4xIn1h")) AS won4x,
           count(*) FILTER (WHERE COALESCE(a."hit10xIn1h", co."hit10xIn1h")) AS won10x,
           count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL
                              AND (COALESCE(a."hit10xIn1h", co."hit10xIn1h") IS NOT NULL
                                   OR NOT (COALESCE(a."hit2xIn1h", co."hit2xIn1h")
                                           AND NOT COALESCE(a."disqualified", co."disqualified", false)))) AS ten_x_graded,
           count(*) FILTER (WHERE COALESCE(a."disqualified", co."disqualified")) AS doubled_after_stop,
           count(COALESCE(a."simReturnPct", co."simReturnPct", co."openReturnPct"))
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS sim_calls,
           sum(COALESCE(a."simReturnPct", co."simReturnPct", co."openReturnPct"))
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL)::float8 AS sim_sum,
           count(co."openReturnPct")
             FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL
                       AND COALESCE(a."simReturnPct", co."simReturnPct") IS NULL) AS sim_open`;
  const callsFrom = Prisma.sql`
    FROM "CuratedAlert" a
    LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
    WHERE a."createdAt" >= ${trendSince} AND a."createdAt" < ${until} AND ${notRetiredModelSql()}
      AND (co."labelRule" IS NULL OR co."labelRule" >= ${REPORTED_LABEL_RULE})`;
  const modelRows = prisma.$queryRaw<RawModelDay[]>`
    SELECT ${createdDay} AS day,
           a."model" AS model,
           max(a."modelName") AS model_name, ${callCols}
    ${callsFrom}
    GROUP BY 1, 2`;
  // The feed: every model's calls pooled, each token once (several models calling one token share
  // its grading row; counting it once per model would read high - firstCallOnRowSql).
  const feedRows = prisma.$queryRaw<RawDay[]>`
    SELECT ${createdDay} AS day, ${callCols}
    ${callsFrom}
      AND ${firstCallOnRowSql()}
    GROUP BY 1`;
  // Each model's clean doubles by day, one row per token: the runners it caught.
  const callWinners = prisma.$queryRaw<DayWinner[]>`
    SELECT DISTINCT ${createdDay} AS day,
           a."tokenId" AS token, a."model" AS model
    FROM "CuratedAlert" a
    LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
    WHERE a."createdAt" >= ${since} AND a."createdAt" < ${until} AND ${notRetiredModelSql()}
      AND (co."labelRule" IS NULL OR co."labelRule" >= ${REPORTED_LABEL_RULE})
      AND COALESCE(a."hit2xIn1h", co."hit2xIn1h")
      AND NOT COALESCE(a."disqualified", co."disqualified", false)`;
  // Which runs to show: every run of a short window, the last run of each UTC day of a longer one
  // (a 90-day window at twelve runs a day would be a thousand rows nobody reads). Columns are
  // timestamp(3) without a zone, stored in UTC, so date_trunc groups by UTC day.
  const runStamps = await prisma.$queryRaw<{ run: Date }[]>`
    SELECT DISTINCT "trainingTo" AS run
    FROM "CuratorModel"
    WHERE "trainingTo" >= ${since} AND "trainingTo" < ${until} AND "contestant" IS NOT NULL
    ORDER BY 1 DESC
    LIMIT ${MAX_RUN_STAMPS}`;
  const chosen = chooseRuns(
    runStamps.map((r) => r.run),
    days <= EVERY_RUN_UP_TO_DAYS,
  );
  // One row per contestant per run; the exam record and fold totals read out of evalMetrics here
  // so the whole blob (folds, curves, the feature report) never leaves the database.
  const runRows =
    chosen.length === 0
      ? Promise.resolve([] as RawRun[])
      : prisma.$queryRaw<RawRun[]>`
    SELECT m."trainingTo" AS at,
           m."contestant" AS contestant,
           m."evalMetrics"->>'contestantName' AS name,
           m."trainingRows" AS training_rows,
           m."trainingFrom" AS training_from,
           (m."evalMetrics"->'exam'->>'calls')::int AS calls,
           (m."evalMetrics"->'exam'->>'wins')::int AS wins,
           (m."evalMetrics"->'exam'->>'goals')::int AS goals,
           (m."evalMetrics"->'exam'->>'tenX')::int AS ten_x,
           (m."evalMetrics"->'exam'->>'tenXGraded')::int AS ten_x_graded,
           (m."evalMetrics"->'exam'->>'sumLabel')::float8 AS sum_label,
           (SELECT sum((f->>'decisionRows')::int)::int
              FROM jsonb_array_elements(COALESCE(m."evalMetrics"->'folds', '[]'::jsonb)) f) AS decision_rows,
           (SELECT sum((f->>'decisionWins')::int)::int
              FROM jsonb_array_elements(COALESCE(m."evalMetrics"->'folds', '[]'::jsonb)) f) AS decision_wins
    FROM "CuratorModel" m
    WHERE m."trainingTo" = ANY(${chosen.map((d) => d.toISOString())}::timestamp(3)[])
      AND m."contestant" IS NOT NULL
    ORDER BY m."trainingTo" DESC`;
  const [market, perModel, feed, runs, mWins, cWins] = await Promise.all([
    marketRows,
    modelRows,
    feedRows,
    runRows,
    marketWinners,
    callWinners,
  ]);
  const dayseries = buildLearningDays(market, feed);
  const runners = runnersByDay(mWins, cWins);
  const feedCaught = caughtByDay(cWins);
  const catchOf = (rates: DayRates, day: string, caught: Map<string, number>) =>
    withCatch(rates, runners.get(day) ?? 0, caught.get(day) ?? 0);
  const firstDay = dayIn(since, timeZone);
  const inWindow = <T extends { day: string }>(rows: T[]) => rows.filter((d) => d.day >= firstDay);
  const precision: PrecisionTargets = {
    winRate: targets.hitRate2xPct / 100,
    goalRate: targets.hitRate4xPct / 100,
    minSupport: MIN_GRADED_FOR_VERDICT,
    confidenceZ: 0,
  };
  return {
    window: { since: since.toISOString(), until: until.toISOString() },
    timeZone,
    days: inWindow(dayseries).map((d) => ({
      ...d,
      market: { ...d.market, runners: runners.get(d.day) ?? 0 },
      feed: catchOf(d.feed, d.day, feedCaught),
    })),
    models: buildLearningModels(market, perModel)
      .map((m) => {
        const caught = caughtByDay(cWins, m.model);
        return {
          ...m,
          days: inWindow(m.days).map((d) => ({ ...d, rates: catchOf(d.rates, d.day, caught) })),
        };
      })
      .filter((m) => m.days.length > 0),
    runs: buildLearningRuns(runs, precision),
    trend: buildLearningTrend(dayseries),
    minGradedForLift: MIN_GRADED_FOR_LIFT,
    trendSpanDays: TREND_SPAN_DAYS,
    note: "Lift is the feed's 2x rate divided by the 2x rate of the moments the models decided on. A rising lift is learning; a rising hit rate with flat lift is the filtered market.",
  };
}
