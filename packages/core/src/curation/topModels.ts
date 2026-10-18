import { prisma } from "../db.js";
import type { ContestantSpec } from "./contestants.js";
import type { Lane } from "./evolution.js";
import { liveCallRecords, liveCatchRates } from "./laneStore.js";
import { emptyRecord, recordScore, withLiveCatch } from "./leaderboard.js";
import type { PrecisionTargets } from "./trainer.js";

/**
 * The default feed: the calls of the three models with the best composite score (recordScore in
 * leaderboard.ts, live catch included) over the last TOP_MODELS_RANK_WINDOW_HOURS of graded live
 * calls, among models with at least TOP_MODELS_RANK_MIN_GRADED of them, combined - user decision
 * 2026-10-18: "make sure this new composite score is the one used wherever we score models". The
 * score is proven like the lower bound was (PRIOR_CALLS phantom misses), and the graded floor below
 * still keeps a short record out.
 *
 * From 2026-10-14 to 10-18 it was the 2x Wilson lower bound (full audit P9), which replaced the
 * leaderboard's composite score of the time. The score paid 15 points for catching runners, so
 * loose seats took the slots: on a replay of 10-08..10-14 its trio did no better than three random
 * seats (notes/full-audit-2026-10-14/lane4-models-training.md H-2). The lower bound ranks on the
 * goal's own outcome, the 2x, and discounts a short record for its noise, so a seat needs both a
 * good rate and the volume to show it. Everyone who follows the default sees it, and so do
 * guests, and Telegram falls back to it. The single champion (champion.ts) still exists for what
 * needs one model: the AI reviewer, and the fallback below.
 *
 * Guards against noise:
 *  - the floor on graded calls in the ranking window, so a model that has gone quiet, or a new
 *    seat on a handful of calls, can't win a slot (the lower bound already discounts it);
 *  - the top 3 is picked once per TOP_MODELS_REFRESH_MINUTES slot (6 hours, starting 00/06/12/18
 *    UTC; user decision 2026-10-12 - every 15 minutes it changed in about one hour of every three),
 *    over a window with a fixed end (topModelsWindow), and stored (TopModelsPick), so the API and
 *    the worker's Telegram dispatcher read the same pick for the whole slot, through restarts and
 *    the training runs in between;
 *  - a held model that can no longer call (its new run can't, or a combiner sits out) gives its
 *    place to the next-ranked model that can, rather than holding a silent slot until the next pick;
 *  - with fewer than TOP_MODELS_COUNT qualifying models the pick is the ones that do; with none the
 *    default stays on the single champion.
 *
 * The champion always joins the default feed (resolveDefaultModels, feedModels.ts; user decisions
 * 2026-10-14 and 2026-10-15): when it did not rank into the pick it is added after it, so the
 * default feed is 4 models at most.
 *
 * The same read also names the "best" model (user decision 2026-10-12): the best average return
 * under the fixed exit plan over the last 24 hours, and gives each model's 24h record for the
 * dropdown, both under the 24h floor (TOP_MODELS_MIN_GRADED).
 */

export const TOP_MODELS_COUNT = 3;
/** The window of the dropdown's records and the "best" pick. */
export const TOP_MODELS_WINDOW_HOURS = 24;
/** Graded calls in the 24h window a model needs to be ranked in the dropdown and for "best". */
export const TOP_MODELS_MIN_GRADED = 30;
/**
 * The window the top models are ranked over: the long end of the 24-72h the user picked, so each
 * seat's lower bound rests on a few hundred calls, where seats a couple of points apart can be
 * told from noise at all.
 */
export const TOP_MODELS_RANK_WINDOW_HOURS = 72;
/** Graded calls in the ranking window a model needs to take a slot: the 24h floor, per day. */
export const TOP_MODELS_RANK_MIN_GRADED = TOP_MODELS_MIN_GRADED * (TOP_MODELS_RANK_WINDOW_HOURS / 24);
export const TOP_MODELS_REFRESH_MINUTES = 360;
/**
 * The window ends this long before the refresh slot starts. A call is graded about 30 minutes
 * after it is made, so a window running up to the slot would gain grades while the slot lasts,
 * and two processes reading it a few minutes apart could rank different records.
 */
export const TOP_MODELS_GRADE_LAG_MINUTES = 45;

export interface TopModelStanding {
  id: string;
  /** Can send now (has a usable cutoff, isn't a control seat). */
  calling: boolean;
  graded: number;
  wins: number;
  /** Graded calls with a simulated exit-plan return, and their sum in percent. */
  simCalls?: number;
  sumSimReturnPct?: number;
  /** The record's composite score (recordScore, live catch included), 0-100; null with nothing graded. */
  score?: number | null;
}

/** One model's record over the window, as the dropdown shows it. */
export interface Last24h {
  graded: number;
  /** 2x hit rate in percent; null with nothing graded. */
  hitRate2xPct: number | null;
  /** Average exit-plan return in percent; null with no simulated returns. */
  avgReturnPct: number | null;
  /** Has the graded calls (and can call) to be ranked for the top models and "best". */
  qualifies: boolean;
}

export function last24hOf(s: TopModelStanding, minGraded = TOP_MODELS_MIN_GRADED): Last24h {
  return {
    graded: s.graded,
    hitRate2xPct: s.graded > 0 ? (100 * s.wins) / s.graded : null,
    avgReturnPct: (s.simCalls ?? 0) > 0 ? (s.sumSimReturnPct ?? 0) / s.simCalls! : null,
    qualifies: s.calling && s.graded >= minGraded,
  };
}

export interface TopModels {
  /** The top models, best score first (up to TOP_MODELS_COUNT); null when none qualify. */
  top: string[] | null;
  /** The best score over the 24h window; null when no model qualifies. */
  best: string | null;
  /** Every roster model's record over the 24h window. */
  last24h: Map<string, Last24h>;
}

const scoreOf = (s: TopModelStanding) => s.score ?? -1;

/**
 * Every calling model with at least `minGraded` graded calls, best composite score first (ties:
 * more graded calls, then id). `standings` are records over the ranking window.
 */
export function rankTopModels(
  standings: readonly TopModelStanding[],
  minGraded = TOP_MODELS_RANK_MIN_GRADED,
): string[] {
  return standings
    .filter((s) => s.calling && s.graded >= minGraded && s.graded > 0)
    .sort((a, b) => scoreOf(b) - scoreOf(a) || b.graded - a.graded || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

/** The first `count` of rankTopModels; null when fewer than `count` qualify. */
export function pickTopModels(
  standings: readonly TopModelStanding[],
  count = TOP_MODELS_COUNT,
  minGraded = TOP_MODELS_RANK_MIN_GRADED,
): string[] | null {
  const ranked = rankTopModels(standings, minGraded);
  return ranked.length < count ? null : ranked.slice(0, count);
}

/**
 * A slot's held pick as it can be served now: its models that can still call, in held order,
 * topped back up from `ranked` (the ranking over the same fixed window) when one of them can't.
 * A held pick that was empty (none qualified at the slot's start) stays empty. Null = none.
 */
export function servableTopModels(
  held: readonly string[],
  calling: readonly string[],
  ranked: readonly string[],
  count = TOP_MODELS_COUNT,
): string[] | null {
  if (held.length === 0) return null;
  const models = held.filter((id) => calling.includes(id));
  for (const id of ranked) {
    if (models.length >= count) break;
    if (!models.includes(id) && calling.includes(id)) models.push(id);
  }
  return models.length > 0 ? models : null;
}

/**
 * The "best" model: the best composite score among calling models with at least `minGraded`
 * graded calls (ties: more graded calls, then id). Null when none qualify. It was the best average
 * exit-plan return until 2026-10-18; the score now carries the return as its second-largest part.
 */
export function pickBestModel(
  standings: readonly TopModelStanding[],
  minGraded = TOP_MODELS_MIN_GRADED,
): string | null {
  return rankTopModels(standings, minGraded)[0] ?? null;
}

/**
 * The windows the read covers: the 24 hours (and, for the ranking, the
 * TOP_MODELS_RANK_WINDOW_HOURS) of calls ending TOP_MODELS_GRADE_LAG_MINUTES before the current
 * refresh slot starts, so every call in them has been graded.
 */
export function topModelsWindow(now: Date): { since: Date; rankSince: Date; until: Date; slot: number } {
  const step = TOP_MODELS_REFRESH_MINUTES * 60_000;
  const slot = Math.floor(now.getTime() / step) * step;
  const until = slot - TOP_MODELS_GRADE_LAG_MINUTES * 60_000;
  return {
    since: new Date(until - TOP_MODELS_WINDOW_HOURS * 3_600_000),
    rankSince: new Date(until - TOP_MODELS_RANK_WINDOW_HOURS * 3_600_000),
    until: new Date(until),
    slot,
  };
}

/**
 * The slot's stored pick, storing `fresh` first when the slot has none. The first process to read a
 * slot decides it; any other reads the stored one, so a pick made by the API and one made by the
 * worker can't differ. The stored pick is then served through servableTopModels: models that left
 * the roster or can't call now are dropped, and the next-ranked calling models take their places.
 */
async function heldTopModels(
  slotStart: Date,
  fresh: string[] | null,
  ranked: readonly string[],
  calling: readonly string[],
): Promise<string[] | null> {
  await prisma.topModelsPick.createMany({ data: [{ slotStart, models: fresh ?? [] }], skipDuplicates: true });
  const held = await prisma.topModelsPick.findUnique({ where: { slotStart } });
  return servableTopModels(held?.models ?? fresh ?? [], calling, ranked);
}

const cache = new Map<string, Promise<TopModels>>();

/** Test hook. */
export function resetTopModelsCache(): void {
  cache.clear();
}

/**
 * Today's top models (and best model) for this roster, read once per refresh slot per
 * process (and again when the roster, the lanes or who can call change). A failed read is not
 * kept, so the next caller retries it.
 */
export function loadTopModels(
  roster: readonly ContestantSpec[],
  lanes: readonly Lane[],
  canCall: (id: string) => boolean,
  /** The hit-rate targets the score is read against (curatedTargets in champion.ts). */
  targets: PrecisionTargets,
  now: Date = new Date(),
): Promise<TopModels> {
  const { since, rankSince, until, slot } = topModelsWindow(now);
  const ids = roster.map((c) => c.id);
  const calling = roster.filter((c) => c.control !== true && canCall(c.id)).map((c) => c.id);
  const lanesKey = lanes.map((l) => `${l.slot}=${l.name}`).join(",");
  const key = `${slot}|${ids.join(",")}|${calling.join(",")}|${lanesKey}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // One slot's answers are all a reader needs; older slots are dropped as a new one fills.
  for (const k of cache.keys()) if (!k.startsWith(`${slot}|`)) cache.delete(k);
  // The catch reads have no end bound: they run to now, and the grade lag's few minutes barely
  // move a day's share. The pick is stored per slot (heldTopModels), so it can't drift with them.
  const read = Promise.all([
    liveCallRecords(ids, since, lanes, { until }),
    liveCallRecords(ids, rankSince, lanes, { until }),
    liveCatchRates(ids, since, lanes),
    liveCatchRates(ids, rankSince, lanes),
  ]).then(async ([day, rankWindow, dayCatch, rankCatch]) => {
    const standingsOf = (records: typeof day, catches: typeof dayCatch): TopModelStanding[] =>
      ids.map((id) => {
        const r = records.get(id);
        return {
          score: recordScore(withLiveCatch(r ?? emptyRecord(), catches.byModel.get(id)), targets),
          id,
          calling: calling.includes(id),
          graded: r?.graded ?? 0,
          wins: r?.wins ?? 0,
          simCalls: r?.simCalls ?? 0,
          sumSimReturnPct: r?.sumSimReturnPct ?? 0,
        };
      });
    const daily = standingsOf(day, dayCatch);
    const ranked = rankTopModels(standingsOf(rankWindow, rankCatch));
    // Fewer than TOP_MODELS_COUNT qualifying still makes a pick of the ones that do: before, two
    // proven models were dropped for the champion alone.
    const fresh = ranked.length > 0 ? ranked.slice(0, TOP_MODELS_COUNT) : null;
    return {
      top: await heldTopModels(new Date(slot), fresh, ranked, calling),
      best: pickBestModel(daily),
      last24h: new Map(daily.map((s) => [s.id, last24hOf(s)])),
    };
  });
  cache.set(key, read);
  read.catch(() => cache.delete(key));
  return read;
}
