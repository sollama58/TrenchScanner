import { TOP_MODELS_COUNT, liveCallRecords, prisma, type Env } from "@trenchscanner/core";
import { wilsonLowerBound } from "@trenchscanner/core/wilson";
import { contestState } from "./contest.js";
import { knownSideName, readKolRows } from "./kolRoster.js";
import { SharedCache } from "./sharedCache.js";

/**
 * The Models tab's "Models vs KOLs" (user ask 2026-11-02): the top three models' 2x, 4x and 10x
 * hit rates over 24 hours, 3 days and 7 days, beside the KOLs we track.
 *
 * Models: the default feed's top-3 pick (core curation/topModels.ts, ranked on its composite score
 * over 72h and refreshed every six hours), best first. Their live calls, graded as everywhere else
 * on the tab (liveCallRecords): a clean 2x within 15 minutes, 4x within 30, 10x within the hour,
 * each before the 50% stop.
 *
 * KOLs: every wallet on the roster (KolWallet), a Known Side counting as its KOL, as the Lighthouse's
 * "Wallets to watch" counts them (walletScorecards.ts). A KOL's "call" is a tracked coin it bought
 * (one whose trade tape was read, TokenWalletActivity) AT OR BEFORE the moment our clock started on
 * that coin (the tape's anchor: the model's call, or a sampled decision moment). That coin is then
 * graded by the very label a model's call is (the tape's CandidateOutcome), so both sides run on
 * the same clock and the same stop. A buy after the clock started is left out: the coin could
 * already have run, and counting it would credit a KOL for buying something that had already
 * doubled. The KOL got in at or below the price the grade starts from, so the rate is, if anything,
 * generous to them.
 *
 * The top KOLs: the TOP_KOLS with the best 2x lower bound (Wilson, 90%) over the 7-day window,
 * among those with KOL_MIN_GRADED graded calls there: a high rate on a handful of coins doesn't
 * outrank a good one on many. The same KOLs (and models) are shown in every window. Read-only
 * aggregates over tables the worker keeps; a fill makes no outside calls.
 */

const DAY_MS = 86_400_000;
export const VS_KOLS_WINDOWS = [1, 3, 7] as const;
/** The window the KOLs are ranked on: the longest, where their records are least noisy. */
const RANK_DAYS = 7;
export const TOP_KOLS = 3;
/** Graded calls in the ranking window a KOL needs to be ranked. */
export const KOL_MIN_GRADED = 10;
/** z for the 90% lower bound the KOLs are ranked by (the dashboard's Z90). */
const RANK_Z = 1.645;
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
  kind: "model" | "kol" | "kols";
  name: string;
  /** KOLs: the X handle and the API path of its picture (kolRoster.ts); null on models. */
  twitter: string | null;
  avatar: string | null;
  /** One per VS_KOLS_WINDOWS, in that order. */
  windows: VsTiers[];
}

export interface ModelsVsKols {
  windows: readonly number[];
  models: VsRow[];
  kols: VsRow[];
  /** Every KOL on the roster pooled: each coin once, however many of them bought it. */
  allKols: VsRow;
  /** KOLs with a graded call in the ranking window (ranked or not). */
  kolsActive: number;
  rule: { rankDays: number; minGraded: number; topKols: number; topModels: number };
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

/** The pooled roster's calls: each coin once, at the first buy any KOL made in it. */
export function pooledCalls(calls: readonly KolCall[]): KolCall[] {
  const first = new Map<string, KolCall>();
  for (const c of calls) {
    const seen = first.get(c.mint);
    if (!seen || c.boughtAt < seen.boughtAt) first.set(c.mint, c);
  }
  return [...first.values()];
}

/**
 * The top KOLs: by 2x lower bound over the ranking window, among those with `minGraded` graded calls
 * there; more graded calls breaks a tie. Pure: tested on its own.
 */
export function rankKols(
  byWho: ReadonlyMap<string, VsTiers>,
  opts: { top: number; minGraded: number },
): string[] {
  return [...byWho.entries()]
    .filter(([, t]) => t.graded >= opts.minGraded)
    .map(([who, t]) => ({ who, t, lb: wilsonLowerBound(t.won2x, t.graded, RANK_Z) }))
    .sort((a, b) => b.lb - a.lb || b.t.graded - a.t.graded || a.who.localeCompare(b.who))
    .slice(0, opts.top)
    .map((r) => r.who);
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

const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

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
      kind: "model",
      name: spec?.name ?? id,
      twitter: null,
      avatar: null,
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
  const rankIndex = windows.indexOf(RANK_DAYS as (typeof windows)[number]);
  const ranked = new Map<string, VsTiers>();
  let kolsActive = 0;
  for (const [who, list] of byWho) {
    const t = windowTiers(list, now, [RANK_DAYS])[0]!;
    if (t.graded > 0) kolsActive++;
    ranked.set(who, t);
  }
  const topKols = rankKols(ranked, { top: TOP_KOLS, minGraded: KOL_MIN_GRADED });
  const names = await readKolRows(topKols);
  const kols: VsRow[] = topKols.map((who) => {
    const kol = names.get(who);
    return {
      id: who,
      kind: "kol",
      name: (kol ? (kol.main ? knownSideName(kol.main) : kol.name) : null) ?? shortAddress(who),
      twitter: kol?.twitter ?? null,
      avatar: kol?.avatar ?? null,
      windows: windowTiers(byWho.get(who) ?? [], now, windows),
    };
  });

  return {
    windows,
    models,
    kols,
    allKols: {
      id: "all-kols",
      kind: "kols",
      name: "Every KOL we track",
      twitter: null,
      avatar: null,
      windows: windowTiers(pooledCalls(calls), now, windows),
    },
    kolsActive,
    rule: {
      rankDays: windows[rankIndex] ?? RANK_DAYS,
      minGraded: KOL_MIN_GRADED,
      topKols: TOP_KOLS,
      topModels: TOP_MODELS_COUNT,
    },
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
