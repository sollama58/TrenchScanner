import {
  prisma,
  Prisma,
  walletSafetyCutsSql,
  firstCallOnRowSql,
  notRetiredModelSql,
  REPORTED_LABEL_RULE,
} from "@trenchscanner/core";

/**
 * The Admin Models "Explorer": how every seat and the pooled feed did over any window from
 * 30 minutes to 7 days, against the same span just before it, with the window cut into buckets
 * so a reader can trend it. The figures are the model audits' (notes/model-audit-2026-10-26):
 * 2x/4x/10x rates, outcomes, lift over the decision moments' base, detection to first alert,
 * the fast path against the cycle, and how often TokenSage's read and the curve tape were in.
 *
 * Grading is the leaderboard's (learningCurve.ts): an alert's copied verdict, else its live
 * grading row; the feed counts each grading row once (firstCallOnRowSql); retired seats are out;
 * the base is the event rows that pass today's wallet screen. Rows are read once per window and
 * folded here, so the fold is testable without a database.
 */

export const PERF_MIN_MINUTES = 30;
export const PERF_MAX_MINUTES = 7 * 24 * 60;
/** Bucket widths (minutes) a window is cut into: the narrowest that gives at most this many. */
export const PERF_BUCKET_MINUTES = [5, 10, 15, 30, 60, 120, 180, 360, 720] as const;
const PERF_MAX_BUCKETS = 36;
/** A bucket's rate needs this many graded calls before it is drawn; fewer reads as noise. */
export const PERF_MIN_GRADED_FOR_RATE = 5;
/** Far above a real 14 days (~90k alerts); only bounds a runaway read. */
const PERF_MAX_ROWS = 250_000;

const MINUTE_MS = 60_000;

/** Which decision an alert came from, by its anchor row's sampleKind. */
export type PerfPath = "cycle" | "fast" | "second" | "fresh";

export interface PerfCoverage {
  /** A TokenSage read was in at the decision. Null: the alert has no grading row left. */
  read: boolean | null;
  /** The read was a full-depth one. */
  full: boolean | null;
  /** The read included the X account/post. */
  xRead: boolean | null;
  /** The coin's bonding curve was on the worker's curve tape at the decision (curveCoveredSec). */
  tape: boolean | null;
}

export interface PerfAlertRow extends PerfCoverage {
  at: number;
  model: string;
  modelName: string | null;
  tokenId: string;
  tier: string | null;
  calibratedPct: number | null;
  /** The anchor row's sampleKind, null when it is gone. */
  kind: string | null;
  /** The first call on its grading row - the pooled feed counts only these. */
  firstOnRow: boolean;
  /** The coin's first alert from any live seat, ever. */
  firstForToken: boolean;
  /** This seat's first call on the coin, ever. */
  firstForModel: boolean;
  hit2x: boolean | null;
  disqualified: boolean | null;
  hit4x: boolean | null;
  hit10x: boolean | null;
  simPct: number | null;
  simOpen: boolean;
  peakPct: number | null;
  detectedAt: number | null;
  launchedAt: number | null;
}

export interface PerfMomentRow extends PerfCoverage {
  at: number;
  kind: "event" | "entry";
  hit2x: boolean | null;
  disqualified: boolean | null;
  hit4x: boolean | null;
}

export interface PerfWindow {
  since: Date;
  until: Date;
}

export function pathOf(kind: string | null): PerfPath {
  if (kind === "event") return "cycle";
  if (kind === "entry") return "fast";
  if (kind === "second") return "second";
  return "fresh";
}

export function bucketMinutesFor(spanMinutes: number): number {
  for (const b of PERF_BUCKET_MINUTES) if (spanMinutes / b <= PERF_MAX_BUCKETS) return b;
  return PERF_BUCKET_MINUTES[PERF_BUCKET_MINUTES.length - 1]!;
}

// ---------- Tallies ----------

interface Tally {
  calls: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  tenXGraded: number;
  afterStop: number;
  simN: number;
  simSum: number;
  simOpen: number;
  predN: number;
  predSum: number;
  peaks: number[];
}

const emptyTally = (): Tally => ({
  calls: 0,
  graded: 0,
  won2x: 0,
  won4x: 0,
  won10x: 0,
  tenXGraded: 0,
  afterStop: 0,
  simN: 0,
  simSum: 0,
  simOpen: 0,
  predN: 0,
  predSum: 0,
  peaks: [],
});

type Graded = Pick<PerfAlertRow, "hit2x" | "disqualified" | "hit4x"> &
  Partial<Pick<PerfAlertRow, "hit10x" | "simPct" | "simOpen" | "peakPct" | "calibratedPct">>;

function add(t: Tally, r: Graded): void {
  t.calls += 1;
  if (r.calibratedPct !== null && r.calibratedPct !== undefined) {
    t.predN += 1;
    t.predSum += r.calibratedPct;
  }
  if (r.hit2x === null) return;
  t.graded += 1;
  const clean = r.hit2x && !r.disqualified;
  if (clean) t.won2x += 1;
  if (r.hit4x) t.won4x += 1;
  if (r.disqualified) t.afterStop += 1;
  // A clean winner's 10x verdict waits for its hour; until then it is not graded for 10x.
  if (r.hit10x !== undefined && (r.hit10x !== null || !clean)) {
    t.tenXGraded += 1;
    if (r.hit10x) t.won10x += 1;
  }
  if (r.simPct !== null && r.simPct !== undefined) {
    t.simN += 1;
    t.simSum += r.simPct;
    if (r.simOpen) t.simOpen += 1;
  }
  if (r.peakPct !== null && r.peakPct !== undefined) t.peaks.push(r.peakPct);
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/** The value at quantile q of ascending-sorted values, interpolated. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface PerfOutcomes {
  calls: number;
  graded: number;
  pending: number;
  hit2xPct: number | null;
  hit4xPct: number | null;
  hit10xPct: number | null;
  /** Doubled, but only after breaching the stop: graded a loss. */
  afterStopPct: number | null;
  /** The share of graded calls by outcome, adding to 100: 10x, 4x, 2x, doubled after the stop, miss. */
  mix: { tenX: number; fourX: number; twoX: number; afterStop: number; miss: number } | null;
  /** Mean of the calibrated 2x rate the seats stated as they called, percent. */
  predictedPct: number | null;
  simAvgPct: number | null;
  simOpen: number;
  peakMedianPct: number | null;
}

function outcomes(t: Tally): PerfOutcomes {
  const peaks = [...t.peaks].sort((a, b) => a - b);
  // 10x and 4x are nested in the 2x; the mix splits them so its parts add up.
  const tenX = t.won10x;
  const fourX = Math.max(0, t.won4x - tenX);
  const twoX = Math.max(0, t.won2x - t.won4x);
  const miss = Math.max(0, t.graded - t.won2x - t.afterStop);
  return {
    calls: t.calls,
    graded: t.graded,
    pending: t.calls - t.graded,
    hit2xPct: pct(t.won2x, t.graded),
    hit4xPct: pct(t.won4x, t.graded),
    hit10xPct: pct(t.won10x, t.tenXGraded),
    afterStopPct: pct(t.afterStop, t.graded),
    mix:
      t.graded > 0
        ? {
            tenX: pct(tenX, t.graded)!,
            fourX: pct(fourX, t.graded)!,
            twoX: pct(twoX, t.graded)!,
            afterStop: pct(t.afterStop, t.graded)!,
            miss: pct(miss, t.graded)!,
          }
        : null,
    predictedPct: t.predN > 0 ? round1(t.predSum / t.predN) : null,
    simAvgPct: t.simN > 0 ? round1(t.simSum / t.simN) : null,
    simOpen: t.simOpen,
    peakMedianPct: round1(quantile(peaks, 0.5)),
  };
}

export interface PerfCoverageShares {
  rows: number;
  readPct: number | null;
  fullPct: number | null;
  xReadPct: number | null;
  tapePct: number | null;
}

function coverage(rows: readonly PerfCoverage[]): PerfCoverageShares {
  const known = rows.filter((r) => r.read !== null);
  const share = (k: keyof PerfCoverage) => pct(known.filter((r) => r[k]).length, known.length);
  return {
    rows: known.length,
    readPct: share("read"),
    fullPct: share("full"),
    xReadPct: share("xRead"),
    tapePct: share("tape"),
  };
}

export interface PerfTiming {
  coins: number;
  medianSec: number | null;
  p25Sec: number | null;
  p75Sec: number | null;
  p90Sec: number | null;
  under1mPct: number | null;
  under2mPct: number | null;
  launchMedianSec: number | null;
}

/** Detection (Token.firstSeenAt) to the alert, over alerts that are a coin's first. */
function timing(rows: readonly PerfAlertRow[]): PerfTiming {
  const secs = rows
    .filter((r) => r.detectedAt !== null)
    .map((r) => Math.max(0, (r.at - r.detectedAt!) / 1000))
    .sort((a, b) => a - b);
  const launch = rows
    .filter((r) => r.launchedAt !== null)
    .map((r) => Math.max(0, (r.at - r.launchedAt!) / 1000))
    .sort((a, b) => a - b);
  const q = (v: readonly number[], p: number) => {
    const x = quantile(v, p);
    return x === null ? null : Math.round(x);
  };
  return {
    coins: secs.length,
    medianSec: q(secs, 0.5),
    p25Sec: q(secs, 0.25),
    p75Sec: q(secs, 0.75),
    p90Sec: q(secs, 0.9),
    under1mPct: pct(secs.filter((s) => s < 60).length, secs.length),
    under2mPct: pct(secs.filter((s) => s < 120).length, secs.length),
    launchMedianSec: q(launch, 0.5),
  };
}

// ---------- The report ----------

export interface PerfPeriod {
  since: string;
  until: string;
  alerts: number;
  coins: number;
  alertsPerHour: number;
  coinsPerHour: number;
  /** The pooled feed, each grading row once (or the one seat, when the report is for one). */
  feed: PerfOutcomes;
  /** The base the lift divides by: the cycle's decision moments (event rows). */
  market: PerfOutcomes;
  /** The fast path's decision moments (entry rows): its own base. */
  entryMarket: PerfOutcomes;
  lift: number | null;
  timing: PerfTiming;
  /** On the calls counted in `feed`. */
  coverage: PerfCoverageShares;
  /** On the decision moments: the cycle's (event rows) and the fast path's (entry rows). */
  eventCoverage: PerfCoverageShares;
  entryCoverage: PerfCoverageShares;
}

export interface PerfPathRow {
  path: PerfPath;
  sharePct: number | null;
  outcomes: PerfOutcomes;
  /** Lift over that path's own base: event rows for the cycle, entry rows for the fast path. */
  lift: number | null;
  timing: PerfTiming;
  coverage: PerfCoverageShares;
}

export interface PerfModelRow {
  id: string;
  name: string;
  calls: number;
  coins: number;
  callsPerHour: number;
  outcomes: PerfOutcomes;
  lift: number | null;
  high: PerfOutcomes;
  fastSharePct: number | null;
  cycle2xPct: number | null;
  fast2xPct: number | null;
  medianAgeSec: number | null;
  readPct: number | null;
  prior: {
    calls: number;
    graded: number;
    hit2xPct: number | null;
    lift: number | null;
    simAvgPct: number | null;
  };
}

export interface PerfBucket {
  at: string;
  alerts: number;
  coins: number;
  graded: number;
  hit2xPct: number | null;
  base2xPct: number | null;
  lift: number | null;
  simAvgPct: number | null;
  medianDetectSec: number | null;
  readPct: number | null;
  fastSharePct: number | null;
}

export interface ModelPerformanceReport {
  builtAt: string;
  model: string | null;
  modelName: string | null;
  minutes: number;
  bucketMinutes: number;
  current: PerfPeriod;
  prior: PerfPeriod;
  paths: PerfPathRow[];
  models: PerfModelRow[];
  series: { current: PerfBucket[]; prior: PerfBucket[] };
  /** Newer alerts than this have not had their 15-minute window and 30-minute label close. */
  gradedThrough: string;
  minGradedForRate: number;
  truncated: boolean;
}

const liftOf = (rate: number | null, base: number | null) =>
  rate !== null && base !== null && base > 0 ? Math.round((rate / base) * 100) / 100 : null;

function within<T extends { at: number }>(rows: readonly T[], since: number, until: number): T[] {
  return rows.filter((r) => r.at >= since && r.at < until);
}

function tallyOf(rows: readonly Graded[]): Tally {
  const t = emptyTally();
  for (const r of rows) add(t, r);
  return t;
}

function period(
  alerts: readonly PerfAlertRow[],
  moments: readonly PerfMomentRow[],
  w: { since: number; until: number },
  model: string | null,
): PerfPeriod {
  const a = within(alerts, w.since, w.until);
  const m = within(moments, w.since, w.until);
  const scoped = model ? a.filter((r) => r.model === model) : a.filter((r) => r.firstOnRow);
  const feed = outcomes(tallyOf(scoped));
  const market = outcomes(tallyOf(m.filter((r) => r.kind === "event")));
  const entryMarket = outcomes(tallyOf(m.filter((r) => r.kind === "entry")));
  const hours = (w.until - w.since) / 3_600_000;
  const counted = model ? a.filter((r) => r.model === model) : a;
  const coins = new Set(counted.map((r) => r.tokenId)).size;
  const firsts = model
    ? a.filter((r) => r.model === model && r.firstForModel)
    : a.filter((r) => r.firstForToken);
  return {
    since: new Date(w.since).toISOString(),
    until: new Date(w.until).toISOString(),
    alerts: counted.length,
    coins,
    alertsPerHour: Math.round((counted.length / hours) * 10) / 10,
    coinsPerHour: Math.round((coins / hours) * 10) / 10,
    feed,
    market,
    entryMarket,
    lift: liftOf(feed.hit2xPct, market.hit2xPct),
    timing: timing(firsts),
    coverage: coverage(scoped),
    eventCoverage: coverage(m.filter((r) => r.kind === "event")),
    entryCoverage: coverage(m.filter((r) => r.kind === "entry")),
  };
}

function buckets(
  alerts: readonly PerfAlertRow[],
  moments: readonly PerfMomentRow[],
  since: number,
  until: number,
  bucketMs: number,
  model: string | null,
): PerfBucket[] {
  const out: PerfBucket[] = [];
  for (let start = since; start < until; start += bucketMs) {
    const end = Math.min(until, start + bucketMs);
    const a = within(alerts, start, end);
    const scoped = model ? a.filter((r) => r.model === model) : a.filter((r) => r.firstOnRow);
    const counted = model ? a.filter((r) => r.model === model) : a;
    const t = tallyOf(scoped);
    const base = tallyOf(within(moments, start, end).filter((r) => r.kind === "event"));
    const rate = t.graded >= PERF_MIN_GRADED_FOR_RATE ? pct(t.won2x, t.graded) : null;
    const baseRate = base.graded >= PERF_MIN_GRADED_FOR_RATE ? pct(base.won2x, base.graded) : null;
    const firsts = model
      ? a.filter((r) => r.model === model && r.firstForModel)
      : a.filter((r) => r.firstForToken);
    out.push({
      at: new Date(start).toISOString(),
      alerts: counted.length,
      coins: new Set(counted.map((r) => r.tokenId)).size,
      graded: t.graded,
      hit2xPct: rate,
      base2xPct: baseRate,
      lift: liftOf(rate, baseRate),
      simAvgPct: t.simN >= PERF_MIN_GRADED_FOR_RATE ? round1(t.simSum / t.simN) : null,
      medianDetectSec: timing(firsts).medianSec,
      readPct: coverage(scoped).readPct,
      fastSharePct: pct(counted.filter((r) => r.kind === "entry").length, counted.length),
    });
  }
  return out;
}

/** The whole report from rows covering [since - span, until): the window and the span before it. */
export function foldModelPerformance(
  alerts: readonly PerfAlertRow[],
  moments: readonly PerfMomentRow[],
  window: PerfWindow,
  opts: { model?: string | null; now?: Date; truncated?: boolean } = {},
): ModelPerformanceReport {
  const model = opts.model ?? null;
  const until = window.until.getTime();
  const since = window.since.getTime();
  const span = until - since;
  const priorSince = since - span;
  const minutes = Math.round(span / MINUTE_MS);
  const bucketMinutes = bucketMinutesFor(minutes);
  const bucketMs = bucketMinutes * MINUTE_MS;
  const cur = { since, until };

  const nowAlerts = within(alerts, since, until);
  const priorAlerts = within(alerts, priorSince, since);
  const nowMoments = within(moments, since, until);
  const eventBase = outcomes(tallyOf(nowMoments.filter((r) => r.kind === "event")));
  const entryBase = outcomes(tallyOf(nowMoments.filter((r) => r.kind === "entry")));
  const priorEventBase = outcomes(
    tallyOf(within(moments, priorSince, since).filter((r) => r.kind === "event")),
  );

  const scoped = model ? nowAlerts.filter((r) => r.model === model) : nowAlerts;
  const paths: PerfPathRow[] = (["cycle", "fast", "second", "fresh"] as const)
    .map((path) => {
      const rows = scoped.filter((r) => pathOf(r.kind) === path);
      const graded = model ? rows : rows.filter((r) => r.firstOnRow);
      const o = outcomes(tallyOf(graded));
      const base = path === "fast" ? entryBase : eventBase;
      const firsts = model ? rows.filter((r) => r.firstForModel) : rows.filter((r) => r.firstForToken);
      return {
        path,
        sharePct: pct(rows.length, scoped.length),
        outcomes: o,
        lift: path === "cycle" || path === "fast" ? liftOf(o.hit2xPct, base.hit2xPct) : null,
        timing: timing(firsts),
        coverage: coverage(graded),
      };
    })
    .filter((p) => p.outcomes.calls > 0);

  const ids = [...new Set(nowAlerts.map((r) => r.model).concat(priorAlerts.map((r) => r.model)))];
  const hours = span / 3_600_000;
  const models: PerfModelRow[] = ids
    .map((id) => {
      const mine = nowAlerts.filter((r) => r.model === id);
      const before = priorAlerts.filter((r) => r.model === id);
      const o = outcomes(tallyOf(mine));
      const po = outcomes(tallyOf(before));
      const cycle = outcomes(tallyOf(mine.filter((r) => r.kind === "event")));
      const fast = outcomes(tallyOf(mine.filter((r) => r.kind === "entry")));
      const ages = mine
        .filter((r) => r.firstForModel && r.detectedAt !== null)
        .map((r) => Math.max(0, (r.at - r.detectedAt!) / 1000))
        .sort((a, b) => a - b);
      const age = quantile(ages, 0.5);
      const name =
        mine.find((r) => r.modelName)?.modelName ?? before.find((r) => r.modelName)?.modelName ?? id;
      return {
        id,
        name,
        calls: mine.length,
        coins: new Set(mine.map((r) => r.tokenId)).size,
        callsPerHour: Math.round((mine.length / hours) * 10) / 10,
        outcomes: o,
        lift: liftOf(o.hit2xPct, eventBase.hit2xPct),
        high: outcomes(tallyOf(mine.filter((r) => r.tier === "high"))),
        fastSharePct: pct(mine.filter((r) => r.kind === "entry").length, mine.length),
        cycle2xPct: cycle.hit2xPct,
        fast2xPct: fast.hit2xPct,
        medianAgeSec: age === null ? null : Math.round(age),
        readPct: coverage(mine).readPct,
        prior: {
          calls: before.length,
          graded: po.graded,
          hit2xPct: po.hit2xPct,
          lift: liftOf(po.hit2xPct, priorEventBase.hit2xPct),
          simAvgPct: po.simAvgPct,
        },
      };
    })
    .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));

  const now = opts.now ?? new Date();
  const modelName = model ? (models.find((m) => m.id === model)?.name ?? model) : null;
  return {
    builtAt: now.toISOString(),
    model,
    modelName,
    minutes,
    bucketMinutes,
    current: period(alerts, moments, cur, model),
    prior: period(alerts, moments, { since: priorSince, until: since }, model),
    paths,
    models,
    series: {
      current: buckets(alerts, moments, since, until, bucketMs, model),
      prior: buckets(alerts, moments, priorSince, since, bucketMs, model),
    },
    // The 15-minute win window decides the 2x; the row is graded when its 30-minute label closes.
    gradedThrough: new Date(Math.min(until, now.getTime() - 30 * MINUTE_MS)).toISOString(),
    minGradedForRate: PERF_MIN_GRADED_FOR_RATE,
    truncated: opts.truncated ?? false,
  };
}

// ---------- The reads ----------

/**
 * The coverage flags of a features column, as SQL columns (null when the row is gone). The tape flag
 * reads curveCoveredSec, set whenever the curve tape is current for the coin. It used to read
 * pathRet1mPct, the scan's own one-minute return, which is null on any coin under a minute old
 * however well its curve is followed: on 10-27/28 it showed 46% of cycle and 18% of fast-path
 * decisions "on the tape" while the curve tape covered 75% and 82% (thread 2026-10-28).
 */
function coverageCols(f: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    CASE WHEN ${f} IS NULL THEN NULL
         ELSE COALESCE((${f}->>'nsRead')::float8 = 1, ${f}->>'nsDepthFull' IS NOT NULL) END AS ns_read,
    CASE WHEN ${f} IS NULL THEN NULL ELSE COALESCE((${f}->>'nsDepthFull')::float8 = 1, false) END AS ns_full,
    CASE WHEN ${f} IS NULL THEN NULL ELSE COALESCE((${f}->>'nsXRead')::float8 = 1, false) END AS ns_x,
    CASE WHEN ${f} IS NULL THEN NULL ELSE ${f}->>'curveCoveredSec' IS NOT NULL END AS tape`;
}

interface RawCoverage {
  ns_read: boolean | null;
  ns_full: boolean | null;
  ns_x: boolean | null;
  tape: boolean | null;
}

const coverageOf = (r: RawCoverage): PerfCoverage => ({
  read: r.ns_read,
  full: r.ns_full,
  xRead: r.ns_x,
  tape: r.tape,
});

/** Reads [since - span, until) and folds it. */
export async function buildModelPerformance(
  window: PerfWindow,
  model: string | null = null,
): Promise<ModelPerformanceReport> {
  const span = window.until.getTime() - window.since.getTime();
  const from = new Date(window.since.getTime() - span);
  const until = window.until;
  const [alertRows, momentRows] = await Promise.all([
    prisma.$queryRaw<
      (RawCoverage & {
        at: Date;
        model: string | null;
        model_name: string | null;
        token: string;
        tier: string | null;
        calibrated: number | null;
        kind: string | null;
        first_on_row: boolean;
        first_for_token: boolean;
        first_for_model: boolean;
        hit2x: boolean | null;
        disq: boolean | null;
        hit4x: boolean | null;
        hit10x: boolean | null;
        sim: number | null;
        sim_open: boolean;
        peak: number | null;
        detected_at: Date | null;
        launched_at: Date | null;
      })[]
    >`
      SELECT a."createdAt" AS at, a."model" AS model, a."modelName" AS model_name,
             a."tokenId" AS token, a."tier" AS tier, a."calibratedPct" AS calibrated,
             co."sampleKind" AS kind,
             ${firstCallOnRowSql()} AS first_on_row,
             NOT EXISTS (SELECT 1 FROM "CuratedAlert" p
                         WHERE p."tokenId" = a."tokenId" AND p."createdAt" < a."createdAt"
                           AND ${notRetiredModelSql("p")}) AS first_for_token,
             NOT EXISTS (SELECT 1 FROM "CuratedAlert" p
                         WHERE p."tokenId" = a."tokenId" AND p."createdAt" < a."createdAt"
                           AND p."model" IS NOT DISTINCT FROM a."model") AS first_for_model,
             COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."disqualified", co."disqualified") AS disq,
             COALESCE(a."hit4xIn1h", co."hit4xIn1h") AS hit4x,
             COALESCE(a."hit10xIn1h", co."hit10xIn1h") AS hit10x,
             COALESCE(a."simReturnPct", co."simReturnPct", co."openReturnPct") AS sim,
             (COALESCE(a."simReturnPct", co."simReturnPct") IS NULL AND co."openReturnPct" IS NOT NULL) AS sim_open,
             COALESCE(a."peak1hReturnPct", co."peak1hReturnPct") AS peak,
             t."firstSeenAt" AS detected_at, t."launchedAt" AS launched_at,
             ${coverageCols(Prisma.sql`co."features"`)}
      FROM "CuratedAlert" a
      JOIN "Token" t ON t."id" = a."tokenId"
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${from} AND a."createdAt" < ${until} AND ${notRetiredModelSql()}
        AND (co."labelRule" IS NULL OR co."labelRule" >= ${REPORTED_LABEL_RULE})
      ORDER BY a."createdAt"
      LIMIT ${PERF_MAX_ROWS}`,
    prisma.$queryRaw<
      (RawCoverage & {
        at: Date;
        kind: "event" | "entry";
        hit2x: boolean | null;
        disq: boolean | null;
        hit4x: boolean | null;
      })[]
    >`
      SELECT "anchorAt" AS at, "sampleKind" AS kind, "hit2xIn1h" AS hit2x,
             "disqualified" AS disq, "hit4xIn1h" AS hit4x,
             ${coverageCols(Prisma.sql`"features"`)}
      FROM "CandidateOutcome"
      WHERE "sampleKind" IN ('event', 'entry')
        AND "anchorAt" >= ${from} AND "anchorAt" < ${until}
        AND ${walletSafetyCutsSql()}
        AND "labelRule" >= ${REPORTED_LABEL_RULE}
      LIMIT ${PERF_MAX_ROWS}`,
  ]);
  const alerts: PerfAlertRow[] = alertRows.map((r) => ({
    ...coverageOf(r),
    at: r.at.getTime(),
    model: r.model ?? "heuristic",
    modelName: r.model_name,
    tokenId: r.token,
    tier: r.tier,
    calibratedPct: r.calibrated,
    kind: r.kind,
    firstOnRow: r.first_on_row,
    firstForToken: r.first_for_token,
    firstForModel: r.first_for_model,
    hit2x: r.hit2x,
    disqualified: r.disq,
    hit4x: r.hit4x,
    hit10x: r.hit10x,
    simPct: r.sim,
    simOpen: r.sim_open,
    peakPct: r.peak,
    detectedAt: r.detected_at ? r.detected_at.getTime() : null,
    launchedAt: r.launched_at ? r.launched_at.getTime() : null,
  }));
  const moments: PerfMomentRow[] = momentRows.map((r) => ({
    ...coverageOf(r),
    at: r.at.getTime(),
    kind: r.kind,
    hit2x: r.hit2x,
    disqualified: r.disq,
    hit4x: r.hit4x,
  }));
  return foldModelPerformance(alerts, moments, window, {
    model,
    truncated: alertRows.length >= PERF_MAX_ROWS || momentRows.length >= PERF_MAX_ROWS,
  });
}
