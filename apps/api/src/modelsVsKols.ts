import { TOP_MODELS_COUNT, liveCallRecords, prisma, type Env } from "@trenchscanner/core";
import { contestState } from "./contest.js";
import { SharedCache } from "./sharedCache.js";

/**
 * The Models tab's "Models vs KOLs" (user ask 2026-11-02): the top three models' 2x, 4x and 10x
 * hit rates over 24 hours, 3 days and 7 days, beside the typical KOL we track.
 *
 * Models: the default feed's top-3 pick (core curation/topModels.ts, ranked on its composite score
 * over 72h and refreshed every six hours), best first. Their live calls, graded as everywhere else
 * on the tab (liveCallRecords): a clean 2x within 15 minutes, 4x within 30, 10x within the hour,
 * each before the 50% stop.
 *
 * KOLs: every wallet on the roster (KolWallet), a Known Side counting as its KOL, as the Lighthouse's
 * "Wallets to watch" counts them (walletScorecards.ts). A KOL's "pick" is a tracked coin it bought
 * (one whose trade tape was read, TokenWalletActivity) AT OR BEFORE the moment our clock started on
 * that coin (the tape's anchor: the model's call, or a sampled decision moment). That coin is then
 * graded by the very label a model's call is (the tape's CandidateOutcome), so both sides run on
 * the same clock and the same stop. A buy after the clock started is left out: the coin could
 * already have run, and counting it would credit a KOL for buying something that had already
 * doubled. The KOL got in at or below the price the grade starts from, so the rate is, if anything,
 * generous to them.
 *
 * The typical KOL (user ask 2026-11-02, replacing a top-3 KOL ranking the same day): in each window,
 * every KOL with at least KOL_MIN_PICKS graded picks in it counts, and the side's figure is the
 * MEDIAN of their own rates, one KOL one vote. The median, not the mean: KOL rates skew (a few hot
 * hands, many near nothing), and with a floor of a handful of picks one lucky streak would move a
 * mean several points; the median is the KOL in the middle. The mean is served beside it. Read-only
 * aggregates over tables the worker keeps; a fill makes no outside calls.
 */

const DAY_MS = 86_400_000;
export const VS_KOLS_WINDOWS = [1, 3, 7] as const;
/**
 * Graded picks a KOL needs in a window to count in it: about one a day, more in a day's window so a
 * rate rests on more than one or two coins. Below it a KOL's rate is mostly noise (one coin = 0% or 100%).
 */
export const KOL_MIN_PICKS: Readonly<Record<number, number>> = { 1: 3, 3: 6, 7: 10 };
/** Coin rows read, at most: bounds a fill whatever the roster grows to. */
const MAX_ROWS = 60_000;

const CACHE_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000;

/** Calls and their grades over one window. Rates: won2x and won4x of graded, won10x of tenXGraded. */
export interface VsTiers {
  days: number;
  calls: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  /** Graded calls whose 10x is settled: every loss, and every clean win whose hour has closed. */
  tenXGraded: number;
}

export interface VsRow {
  id: string;
  name: string;
  /** One per VS_KOLS_WINDOWS, in that order. */
  windows: VsTiers[];
}

/** A rate per tier, in percent; null with no KOL to read it from. */
export interface TierRates {
  r2x: number | null;
  r4x: number | null;
  r10x: number | null;
}

/** The typical KOL over one window. */
export interface KolTypical {
  days: number;
  /** Graded picks a KOL needed in this window to count. */
  minPicks: number;
  /** KOLs that counted; and every KOL with a graded pick in the window, counted or not. */
  kols: number;
  active: number;
  /** Graded picks of the KOLs that counted. */
  picks: number;
  median: TierRates;
  mean: TierRates;
}

export interface ModelsVsKols {
  windows: readonly number[];
  models: VsRow[];
  /** One per VS_KOLS_WINDOWS, in that order. */
  kol: KolTypical[];
  rule: { topModels: number };
  computedAt: string;
}

/**
 * One KOL's coin: when it first bought it and the coin's grade (null until its window closes). Each
 * tier is already clean (false when the stop came first), as liveCallRecords counts a model's.
 */
export interface KolCall {
  who: string;
  mint: string;
  boughtAt: Date;
  hit2x: boolean | null;
  hit4x: boolean | null;
  hit10x: boolean | null;
  tenXGraded: boolean;
}

const emptyTiers = (days: number): VsTiers => ({
  days,
  calls: 0,
  graded: 0,
  won2x: 0,
  won4x: 0,
  won10x: 0,
  tenXGraded: 0,
});

function add(t: VsTiers, c: KolCall) {
  t.calls++;
  if (c.hit2x === null) return;
  t.graded++;
  if (c.hit2x) t.won2x++;
  if (c.hit4x) t.won4x++;
  if (c.hit10x) t.won10x++;
  if (c.tenXGraded) t.tenXGraded++;
}

/** Each window's tiers over `calls` (already one per coin), the window counted back from `now`. */
export function windowTiers(calls: readonly KolCall[], now: number, windows: readonly number[]): VsTiers[] {
  return windows.map((days) => {
    const since = now - days * DAY_MS;
    const t = emptyTiers(days);
    for (const c of calls) if (c.boughtAt.getTime() >= since) add(t, c);
    return t;
  });
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * The typical KOL over one window from each KOL's tiers in it: the median and mean of the rates of
 * those with `minPicks` graded picks. A KOL's 10x rate counts only once one of its picks has settled
 * the 10x. Pure: tested on its own.
 */
export function typicalKol(perKol: readonly VsTiers[], days: number, minPicks: number): KolTypical {
  const counted = perKol.filter((t) => t.graded >= minPicks);
  const r2 = counted.map((t) => (t.won2x / t.graded) * 100);
  const r4 = counted.map((t) => (t.won4x / t.graded) * 100);
  const r10 = counted.filter((t) => t.tenXGraded > 0).map((t) => (t.won10x / t.tenXGraded) * 100);
  return {
    days,
    minPicks,
    kols: counted.length,
    active: perKol.filter((t) => t.graded > 0).length,
    picks: counted.reduce((n, t) => n + t.graded, 0),
    median: { r2x: median(r2), r4x: median(r4), r10x: median(r10) },
    mean: { r2x: mean(r2), r4x: mean(r4), r10x: mean(r10) },
  };
}

interface RawCall {
  who: string;
  mint: string;
  bought_at: Date;
  hit2x: boolean | null;
  hit4x: boolean | null;
  hit10x: boolean | null;
  ten_x_graded: boolean;
}

/** Every KOL's calls over the longest window: one row per KOL (Known Sides folded in) and coin. */
export async function readKolCalls(since: Date): Promise<KolCall[]> {
  const rows = await prisma.$queryRaw<RawCall[]>`
    WITH tracked AS (
      SELECT k."wallet", COALESCE(k."mainWallet", k."wallet") AS who FROM "KolWallet" k
    )
    SELECT t.who, tk."mintAddress" AS mint, min(a."firstBuyAt") AS bought_at,
           CASE WHEN co."hit2xIn1h" IS NULL THEN NULL
                ELSE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false) END AS hit2x,
           COALESCE(co."hit4xIn1h", false) AND NOT COALESCE(co."disqualified", false) AS hit4x,
           COALESCE(co."hit10xIn1h", false) AND NOT COALESCE(co."disqualified", false) AS hit10x,
           COALESCE(co."hit10xIn1h" IS NOT NULL
                    OR NOT (co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)), false) AS ten_x_graded
    FROM "TokenWalletActivity" a
    JOIN tracked t ON t."wallet" = a."wallet"
    JOIN "TokenTradeTape" tp ON tp."tokenId" = a."tokenId"
    JOIN "CandidateOutcome" co ON co.id = tp."outcomeId"
    JOIN "Token" tk ON tk.id = a."tokenId"
    WHERE a."buys" > 0 AND a."solIn" > 0
      AND a."firstBuyAt" >= ${since}
      -- Bought before our clock started on the coin: see the note at the top.
      AND a."firstBuyAt" <= tp."anchorAt"
    GROUP BY t.who, tk.id, co.id
    LIMIT ${MAX_ROWS}`;
  return rows.map((r) => ({
    who: r.who,
    mint: r.mint,
    boughtAt: r.bought_at,
    hit2x: r.hit2x,
    hit4x: r.hit4x,
    hit10x: r.hit10x,
    tenXGraded: r.hit2x !== null && !!r.ten_x_graded,
  }));
}

export async function buildModelsVsKols(env: Env, now = Date.now()): Promise<ModelsVsKols> {
  const windows = VS_KOLS_WINDOWS;
  const longest = Math.max(...windows);
  const state = await contestState(env);
  // The top-3 pick, best first; the champion the default feed adds after it is not one of them.
  const topIds = state.defaultModels.slice(0, TOP_MODELS_COUNT);
  const [records, calls] = await Promise.all([
    Promise.all(windows.map((days) => liveCallRecords(topIds, new Date(now - days * DAY_MS), state.lanes))),
    readKolCalls(new Date(now - longest * DAY_MS)),
  ]);

  const models: VsRow[] = topIds.map((id) => {
    const spec = state.roster.find((c) => c.id === id);
    return {
      id,
      name: spec?.name ?? id,
      windows: windows.map((days, i) => {
        const r = records[i]?.get(id);
        return {
          days,
          calls: r?.calls ?? 0,
          graded: r?.graded ?? 0,
          won2x: r?.wins ?? 0,
          won4x: r?.goals ?? 0,
          won10x: r?.tenX ?? 0,
          tenXGraded: r?.tenXGraded ?? 0,
        };
      }),
    };
  });

  const byWho = new Map<string, KolCall[]>();
  for (const c of calls) {
    const list = byWho.get(c.who);
    if (list) list.push(c);
    else byWho.set(c.who, [c]);
  }
  const perKol = [...byWho.values()].map((list) => windowTiers(list, now, windows));
  const kol = windows.map((days, i) =>
    typicalKol(
      perKol.map((w) => w[i]!),
      days,
      KOL_MIN_PICKS[days] ?? days,
    ),
  );

  return {
    windows,
    models,
    kol,
    rule: { topModels: TOP_MODELS_COUNT },
    computedAt: new Date(now).toISOString(),
  };
}

/** One shared answer for every reader, subscribers and guests alike: it names no live coin. */
export function createModelsVsKolsCache(env: Env) {
  const cache = new SharedCache<ModelsVsKols>(CACHE_MS, {
    staleWhileRevalidateMs: STALE_MS,
    name: "models vs kols",
  });
  return () => cache.get(() => buildModelsVsKols(env));
}
