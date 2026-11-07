import { decideAdaptiveExit, type FdsaExitReason, type FdsaPositionState } from "./adaptiveExit.js";
import {
  FDSA_DEFAULT_EXIT_PLAN,
  FDSA_HARD_FLOOR_MULTIPLE,
  fdsaExitPlanSchema,
  type FdsaExitPlan,
} from "./exitPlan.js";

/**
 * The FDSA exit lab (owner decision 2026-11-07, "Lab, tuned rule, then learned"): replays an exit
 * plan over a coin's recorded second-by-second price path (PricePathRecord) as FDSA's paper desk
 * would have run it, so exit ideas are measured on thousands of curated alerts instead of FDSA's
 * handful of trades. Phase 1 of the trader models: the replay and a search over the plan's own
 * settings, picked on earlier days and reported on later ones. The learned per-tick trader (phase
 * 2) is scored on the same replay.
 *
 * Pure: the worker's fdsaExitLabJob.ts loads the paths and alerts, this runs the plans. The
 * decision on every tick is the real engine's (decideAdaptiveExit), so the lab and the desk can't
 * drift apart.
 *
 * Frictions, from the desk's first 14 trades (2026-11-02 to 11-04): the fill lands about 16 s after
 * the alert (verdict p50 11 s, fill p50 16 s), the paper pass prices open positions every 10 s
 * (PAPER_TRADING_INTERVAL_MS), and every fill pays the desk's 1% fill penalty. A sale fills at the
 * price a couple of seconds after the tick that decided it, so a crash between ticks fills through
 * the floor as it did live (VC on 2026-11-03: floor 1.50x, filled at 1.10x).
 *
 * Paths cover the curve tape's follow (a coin's first PRICE_PATH_FOLLOW_MINUTES, or to graduation).
 * A position still open when its path ends is marked at the path's last price ("path_end") and
 * counted, so a plan that wins only by holding past what the lab can see shows it.
 */

/** One recorded second, relative to the alert: seconds after it, and the price over the alert's. */
export interface LabPoint {
  sec: number;
  /** Price as a multiple of the price at the alert second. */
  rel: number;
}

export interface LabTrade {
  /** CuratedAlert id (or any stable id). */
  id: string;
  mint: string;
  alertAt: Date;
  /** Seconds after the alert, ascending, each a price change; the first at or before 0. */
  points: readonly LabPoint[];
  /** FDSA's screen shortlisted it: the population the desk actually trades from. */
  shortlisted?: boolean;
  /** Claude's own entry plan, when FDSA reviewed the coin and planned a trade. */
  claudePlan?: FdsaExitPlan | null;
}

export interface LabFrictions {
  /** Seconds from the alert to the entry fill. */
  entryDelaySec: number;
  /** Seconds between the desk's price checks. */
  tickSec: number;
  /** Seconds from the deciding tick to the sale's fill. */
  sellDelaySec: number;
  /** Fill penalty on every buy and sale, percent (the desk's fillPenaltyBps / 100). */
  fillPenaltyPct: number;
}

/** The desk as it ran on 2026-11-02 to 11-04. */
export const FDSA_LAB_FRICTIONS: LabFrictions = {
  entryDelaySec: 16,
  tickSec: 10,
  sellDelaySec: 2,
  fillPenaltyPct: 1,
};

/** The same desk pricing every second, as it could off the curve tape's stream. */
export const FDSA_LAB_STREAM_FRICTIONS: LabFrictions = { ...FDSA_LAB_FRICTIONS, tickSec: 1, sellDelaySec: 1 };

export type LabExitReason = FdsaExitReason | "path_end";

export interface LabResult {
  /** Return on the SOL put in, percent, after the fill penalty. */
  returnPct: number;
  /** Why the last of the position was sold. */
  reason: LabExitReason;
  holdSec: number;
  /** The highest multiple of the entry the path reached while the position was open. */
  pathPeak: number;
}

/** A step function over the points: the price at `sec` is the last change at or before it. */
class PathCursor {
  private i = 0;
  constructor(private readonly points: readonly LabPoint[]) {}
  /** Price at `sec`; `sec` must not go backwards between calls. */
  at(sec: number): number {
    const p = this.points;
    while (this.i + 1 < p.length && p[this.i + 1]!.sec <= sec) this.i += 1;
    return p[this.i]!.rel;
  }
  /** Highest price over (from, to], moving the cursor to `to`. */
  maxTo(to: number): number {
    const p = this.points;
    let max = p[this.i]!.rel;
    while (this.i + 1 < p.length && p[this.i + 1]!.sec <= to) {
      this.i += 1;
      if (p[this.i]!.rel > max) max = p[this.i]!.rel;
    }
    return max;
  }
}

/** The path's last second. */
const endSec = (t: LabTrade) => t.points[t.points.length - 1]?.sec ?? 0;

/**
 * Replays `plan` on one trade as the paper desk would. Null when the path ends before the entry
 * would have filled, or starts after the alert (no price to enter at).
 */
export function replayExitPlan(trade: LabTrade, plan: FdsaExitPlan, fr: LabFrictions): LabResult | null {
  const pts = trade.points;
  if (pts.length === 0 || pts[0]!.sec > 0) return null;
  const last = endSec(trade);
  if (last <= fr.entryDelaySec) return null;
  const pen = fr.fillPenaltyPct / 100;
  // Two cursors: one on the tick the decision is made at, one at the fill a little later.
  const tick = new PathCursor(pts);
  const fill = new PathCursor(pts);
  const peakCursor = new PathCursor(pts);
  const entryRel = tick.at(fr.entryDelaySec) * (1 + pen);
  peakCursor.at(fr.entryDelaySec);
  if (!(entryRel > 0)) return null;

  const openedAt = new Date(0);
  const state: FdsaPositionState = {
    openedAt,
    peakMultiple: null,
    floorMultiple: FDSA_HARD_FLOOR_MULTIPLE,
    soldFraction: 0,
  };
  let proceeds = 0;
  let pathPeak = 1;
  for (let t = fr.entryDelaySec + fr.tickSec; ; t += fr.tickSec) {
    const atEnd = t >= last;
    const now = Math.min(t, last);
    pathPeak = Math.max(pathPeak, peakCursor.maxTo(now) / entryRel);
    const multiple = tick.at(now) / entryRel;
    if (atEnd) {
      const left = Math.max(0, 1 - state.soldFraction);
      proceeds += left * multiple * (1 - pen);
      return finish(proceeds, "path_end", now - fr.entryDelaySec, pathPeak);
    }
    const decision = decideAdaptiveExit(state, multiple, new Date((t - fr.entryDelaySec) * 1_000), plan);
    state.peakMultiple = decision.peakMultiple;
    state.floorMultiple = decision.floorMultiple;
    if (decision.action === "sell") {
      const fillAt = Math.min(t + fr.sellDelaySec, last);
      const fillMultiple = (fill.at(fillAt) / entryRel) * (1 - pen);
      const share = decision.all ? Math.max(0, 1 - state.soldFraction) : decision.fraction;
      proceeds += share * fillMultiple;
      state.soldFraction = Math.min(1, state.soldFraction + share);
      if (decision.all || state.soldFraction >= 1 - 1e-6) {
        return finish(proceeds, decision.reason, fillAt - fr.entryDelaySec, pathPeak);
      }
    }
  }
}

function finish(proceeds: number, reason: LabExitReason, holdSec: number, pathPeak: number): LabResult {
  return { returnPct: (proceeds - 1) * 100, reason, holdSec, pathPeak };
}

export interface LabSummary {
  trades: number;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  /** Share of trades that made money. */
  profitable: number | null;
  /** Mean return of trades that ended on the stop. */
  stopLossMeanPct: number | null;
  /** Mean return of trades whose path doubled the entry, and of those that didn't. */
  doubledMeanPct: number | null;
  notDoubledMeanPct: number | null;
  /** Mean of realized gain over the path's peak gain, on trades that doubled (0-1). */
  captureOfPeak: number | null;
  medianHoldSec: number | null;
  byReason: Partial<Record<LabExitReason, number>>;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs: readonly number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (v: number | null, dp = 2) => (v === null ? null : Number(v.toFixed(dp)));

export function summarizeLab(results: readonly LabResult[]): LabSummary {
  const returns = results.map((r) => r.returnPct);
  const doubled = results.filter((r) => r.pathPeak >= 2);
  const byReason: Partial<Record<LabExitReason, number>> = {};
  for (const r of results) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  return {
    trades: results.length,
    meanReturnPct: round(mean(returns)),
    medianReturnPct: round(median(returns)),
    profitable: round(
      results.length ? results.filter((r) => r.returnPct > 0).length / results.length : null,
      3,
    ),
    stopLossMeanPct: round(mean(results.filter((r) => r.reason === "stop_loss").map((r) => r.returnPct))),
    doubledMeanPct: round(mean(doubled.map((r) => r.returnPct))),
    notDoubledMeanPct: round(mean(results.filter((r) => r.pathPeak < 2).map((r) => r.returnPct))),
    captureOfPeak: round(mean(doubled.map((r) => r.returnPct / 100 / (r.pathPeak - 1))), 3),
    medianHoldSec: round(median(results.map((r) => r.holdSec)), 0),
    byReason,
  };
}

/** Replays one plan over every trade it can (trades whose path can't be entered are left out). */
export function replayAll(trades: readonly LabTrade[], plan: FdsaExitPlan, fr: LabFrictions): LabResult[] {
  const out: LabResult[] = [];
  for (const t of trades) {
    const r = replayExitPlan(t, plan, fr);
    if (r) out.push(r);
  }
  return out;
}

/**
 * The fixed take-profit ladder the hit-rate pages simulate (profitSim.ts EXIT_PLAN), written as an
 * FDSA plan so it runs under the same frictions: 35% at 2x, 30% at 4x, 25% at 10x, a 40% trail from
 * the first sale, the -50% stop, closed at 30 minutes if it never sold, out at 3 hours. Close, not
 * identical: the ladder's stop holds only before the first sale, and the plan's trail arms at 2x.
 */
export const LADDER_AS_FDSA_PLAN: FdsaExitPlan = {
  stopMultiple: FDSA_HARD_FLOOR_MULTIPLE,
  lockIns: [],
  trail: [{ fromMultiple: 2, fraction: 0.4 }],
  partials: [
    { atMultiple: 2, sellFraction: 0.35 },
    { atMultiple: 4, sellFraction: 0.3 },
    { atMultiple: 10, sellFraction: 0.25 },
  ],
  maxHoldMinutes: 180,
  stall: { afterMinutes: 30, belowMultiple: 2 },
};

/**
 * Two rules from the model-system audit's offline replay (2026-11-07, 1,378 called coins of 31 Oct
 * to 3 Nov, the same 16 s entry and 1% each way): a 20% trail armed at 1.2x with a -20% stop and a
 * 30-minute cap returned +10.8% an alert there, and a fixed 1.3x take with a -20% stop and a
 * 10-minute cap about break-even. Scored here as baselines so the lab checks them on its own coins.
 */
export const AUDIT_TRAIL_PLAN: FdsaExitPlan = {
  stopMultiple: 0.8,
  lockIns: [],
  trail: [{ fromMultiple: 1.2, fraction: 0.2 }],
  partials: [],
  maxHoldMinutes: 30,
  stall: null,
};
export const AUDIT_TAKE_PLAN: FdsaExitPlan = {
  stopMultiple: 0.8,
  lockIns: [],
  trail: [],
  partials: [{ atMultiple: 1.3, sellFraction: 1 }],
  maxHoldMinutes: 10,
  stall: null,
};

/**
 * The plans the tuned-rule search tries: every combination of a stop, an early lock-in (protecting
 * a gain under 2x, which no FDSA plan did), an early trail, the trail from 2x, partial sells and a
 * stall rule, 972 in all. Each is a valid FdsaExitPlan (the schema's own refinements hold), so
 * the winner can be handed to the desk as it stands.
 */
export function labPlanGrid(): FdsaExitPlan[] {
  const stops = [0.5, 0.65, 0.8];
  const earlyLocks: FdsaExitPlan["lockIns"][] = [
    [],
    [{ atMultiple: 1.3, floorMultiple: 1.0 }],
    [{ atMultiple: 1.5, floorMultiple: 1.15 }],
  ];
  const earlyTrails: FdsaExitPlan["trail"][] = [
    [],
    [{ fromMultiple: 1.2, fraction: 0.2 }],
    [{ fromMultiple: 1.3, fraction: 0.3 }],
  ];
  const trail2x = [0.2, 0.3, 0.4];
  const partials: FdsaExitPlan["partials"][] = [
    [],
    [{ atMultiple: 2, sellFraction: 0.25 }],
    [{ atMultiple: 2, sellFraction: 0.5 }],
    [
      { atMultiple: 1.5, sellFraction: 0.3 },
      { atMultiple: 2, sellFraction: 0.2 },
    ],
  ];
  const stalls: FdsaExitPlan["stall"][] = [
    null,
    { afterMinutes: 3, belowMultiple: 1.05 },
    { afterMinutes: 6, belowMultiple: 1.1 },
  ];
  const out: FdsaExitPlan[] = [];
  for (const stopMultiple of stops)
    for (const early of earlyLocks)
      for (const earlyTrail of earlyTrails)
        for (const t2 of trail2x)
          for (const p of partials)
            for (const stall of stalls) {
              const plan = fdsaExitPlanSchema.safeParse({
                stopMultiple,
                lockIns: [...early, { atMultiple: 2, floorMultiple: 1 }],
                trail: [
                  ...earlyTrail,
                  { fromMultiple: 2, fraction: t2 },
                  { fromMultiple: 4, fraction: Math.min(t2, 0.3) },
                ],
                partials: p,
                maxHoldMinutes: 180,
                stall,
              });
              if (plan.success) out.push(plan.data);
            }
  return out;
}

export interface LabPlanReport {
  name: string;
  plan: FdsaExitPlan;
  train: LabSummary;
  test: LabSummary;
  /** The same plan priced every second instead of every 10 (the stream), on the test days. */
  testStream?: LabSummary;
}

export interface ExitLabReport {
  frictions: LabFrictions;
  /** The split: trades alerted before `testFrom` choose the plan, the rest grade it. */
  testFrom: string | null;
  trades: { train: number; test: number; shortlisted: number };
  plansTried: number;
  /** The tuned rule: the grid plan with the best mean return on the train days. */
  tuned: LabPlanReport | null;
  /** The next best on train, to show how flat the top is. */
  runnersUp: LabPlanReport[];
  baselines: LabPlanReport[];
  /** The same plans on FDSA's shortlisted coins alone (test days). */
  shortlisted: { name: string; test: LabSummary }[];
  /** Claude's own entry plans, replayed on the coins it planned them for (all days). */
  claudePlans: { trades: number; claude: LabSummary; tunedOnSame: LabSummary | null } | null;
}

export interface ExitLabOptions {
  frictions?: LabFrictions;
  /** Share of the trades, latest first, held out to grade the pick. */
  testShare?: number;
  grid?: FdsaExitPlan[];
  runnersUp?: number;
  /** Awaited after each grid plan, so a long search can hand the event loop back. */
  pause?: () => Promise<void>;
}

/**
 * The lab's run: the baselines (FDSA's default plan, the ladder) and every grid plan on the earlier
 * trades, the best by mean return picked there, and all of them graded on the later trades, which
 * the pick never saw.
 */
export async function runExitLab(
  trades: readonly LabTrade[],
  opts: ExitLabOptions = {},
): Promise<ExitLabReport> {
  const fr = opts.frictions ?? FDSA_LAB_FRICTIONS;
  const grid = opts.grid ?? labPlanGrid();
  const sorted = [...trades].sort((a, b) => a.alertAt.getTime() - b.alertAt.getTime());
  const cut = Math.floor(sorted.length * (1 - (opts.testShare ?? 1 / 3)));
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const testShort = test.filter((t) => t.shortlisted);

  const scored: { plan: FdsaExitPlan; train: LabSummary }[] = [];
  for (const plan of grid) {
    scored.push({ plan, train: summarizeLab(replayAll(train, plan, fr)) });
    await opts.pause?.();
  }
  scored.sort((a, b) => (b.train.meanReturnPct ?? -Infinity) - (a.train.meanReturnPct ?? -Infinity));
  const report = (name: string, plan: FdsaExitPlan, trainSummary?: LabSummary): LabPlanReport => ({
    name,
    plan,
    train: trainSummary ?? summarizeLab(replayAll(train, plan, fr)),
    test: summarizeLab(replayAll(test, plan, fr)),
  });
  const best = scored[0];
  const tuned = best ? report("tuned", best.plan, best.train) : null;
  if (tuned)
    tuned.testStream = summarizeLab(replayAll(test, tuned.plan, { ...fr, tickSec: 1, sellDelaySec: 1 }));
  const runnersUp = scored
    .slice(1, 1 + (opts.runnersUp ?? 4))
    .map((s, i) => report(`runner-up ${i + 1}`, s.plan, s.train));
  const fdsaDefault = report("fdsa-default", FDSA_DEFAULT_EXIT_PLAN);
  fdsaDefault.testStream = summarizeLab(
    replayAll(test, FDSA_DEFAULT_EXIT_PLAN, { ...fr, tickSec: 1, sellDelaySec: 1 }),
  );
  const baselines = [
    fdsaDefault,
    report("ladder", LADDER_AS_FDSA_PLAN),
    report("audit-trail", AUDIT_TRAIL_PLAN),
    report("audit-take", AUDIT_TAKE_PLAN),
  ];

  const shortlisted = [...(tuned ? [tuned] : []), ...baselines].map((r) => ({
    name: r.name,
    test: summarizeLab(replayAll(testShort, r.plan, fr)),
  }));

  // Claude's plans: each on its own coin, against the tuned plan on the same coins.
  const planned = sorted.filter((t) => t.claudePlan);
  let claudePlans: ExitLabReport["claudePlans"] = null;
  if (planned.length > 0) {
    const claude: LabResult[] = [];
    const same: LabResult[] = [];
    for (const t of planned) {
      const r = replayExitPlan(t, t.claudePlan!, fr);
      if (!r) continue;
      claude.push(r);
      if (tuned) {
        const s = replayExitPlan(t, tuned.plan, fr);
        if (s) same.push(s);
      }
    }
    claudePlans = {
      trades: claude.length,
      claude: summarizeLab(claude),
      tunedOnSame: tuned ? summarizeLab(same) : null,
    };
  }

  return {
    frictions: fr,
    testFrom: test[0]?.alertAt.toISOString() ?? null,
    trades: {
      train: train.length,
      test: test.length,
      shortlisted: sorted.filter((t) => t.shortlisted).length,
    },
    plansTried: grid.length,
    tuned,
    runnersUp,
    baselines,
    shortlisted,
    claudePlans,
  };
}

/**
 * A recorded path (absolute prices, seconds from the path's start) cut to a lab trade: seconds
 * relative to the alert and prices over the price at the alert second. Null when the path doesn't
 * cover the alert (starts after it, or ends before it) or the alert's price isn't positive.
 */
export function labPointsFromPath(
  rows: readonly { sec: number; price: number }[],
  pathStartAt: Date,
  alertAt: Date,
): LabPoint[] | null {
  if (rows.length === 0) return null;
  const alertSec = (alertAt.getTime() - pathStartAt.getTime()) / 1_000;
  if (rows[0]!.sec > alertSec || rows[rows.length - 1]!.sec <= alertSec) return null;
  let i = 0;
  while (i + 1 < rows.length && rows[i + 1]!.sec <= alertSec) i += 1;
  const base = rows[i]!.price;
  if (!(base > 0) || !Number.isFinite(base)) return null;
  const out: LabPoint[] = [{ sec: 0, rel: 1 }];
  for (let j = i + 1; j < rows.length; j++) {
    const r = rows[j]!;
    if (!(r.price > 0) || !Number.isFinite(r.price)) continue;
    out.push({ sec: r.sec - alertSec, rel: r.price / base });
  }
  return out;
}
