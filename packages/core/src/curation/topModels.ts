import { prisma } from "../db.js";
import { CHAMPION_WINDOW_DAYS } from "./champion.js";
import type { ContestantSpec } from "./contestants.js";
import type { Lane } from "./evolution.js";
import { liveCallRecords } from "./laneStore.js";
import { compositeScore, emptyRecord, type CallRecord } from "./leaderboard.js";
import type { PrecisionTargets } from "./trainer.js";

/**
 * The default feed: the calls of the three models with the best SCORE (the leaderboard's composite,
 * on the champion's 30-day live record pooled with the latest exam, so it counts runners caught as
 * well as hit rates), combined - user decision 2026-10-12, replacing the best 24h 2x rate. On an
 * hour-by-hour replay of 10-06..10-12 the score's top 3 hit 2x as often (22.0% vs 22.4%) and caught
 * more of the runners (31.8% vs 27.5%), and since the catch rate joined the score the score's
 * order predicted the next hours' 2x rate and return where the 24h rate did not (see
 * notes/feed-slowdown-2026-10-12.md). Everyone who follows the default sees it, and so do
 * guests. The single champion (champion.ts) still exists for what needs one model: the AI
 * reviewer, and the fallback below.
 *
 * Guards against noise:
 *  - a model needs TOP_MODELS_MIN_GRADED graded calls in the last 24 hours to be ranked, so a
 *    model that has gone quiet, or a new seat on a handful of calls, can't win a slot;
 *  - the top 3 is picked once per TOP_MODELS_REFRESH_MINUTES slot (6 hours, starting 00/06/12/18
 *    UTC; user decision 2026-10-12 - every 15 minutes it changed in about one hour of every three),
 *    over a window with a fixed end (topModelsWindow), and stored (TopModelsPick), so the API and
 *    the worker's Telegram dispatcher read the same pick for the whole slot, through restarts and
 *    the training runs in between;
 *  - with fewer than TOP_MODELS_COUNT qualifying models the default stays on the single champion.
 *
 * The same read also names the "best" model (user decision 2026-10-12): the best average return
 * under the fixed exit plan over the same window, under the same floor.
 */

export const TOP_MODELS_COUNT = 3;
export const TOP_MODELS_WINDOW_HOURS = 24;
/** Graded calls in the window a model needs before it can take a slot. */
export const TOP_MODELS_MIN_GRADED = 30;
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
  /** The leaderboard score the top models are ranked on; null or absent = none yet. */
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
  /** The default feed's models, best score first; null when too few qualify. */
  top: string[] | null;
  /** The best average exit-plan return; null when no model qualifies. */
  best: string | null;
  /** Every roster model's record over the window. */
  last24h: Map<string, Last24h>;
}

/**
 * The `count` best scores among calling models with at least `minGraded` graded calls in the
 * window, best first (a model with no score last; ties: the better 2x rate, more graded calls,
 * then id). Null when fewer than `count` qualify.
 */
export function pickTopModels(
  standings: readonly TopModelStanding[],
  count = TOP_MODELS_COUNT,
  minGraded = TOP_MODELS_MIN_GRADED,
): string[] | null {
  const eligible = standings.filter((s) => s.calling && s.graded >= minGraded && s.graded > 0);
  if (eligible.length < count) return null;
  return [...eligible]
    .sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) ||
        b.wins / b.graded - a.wins / a.graded ||
        b.graded - a.graded ||
        a.id.localeCompare(b.id),
    )
    .slice(0, count)
    .map((s) => s.id);
}

/**
 * The highest average exit-plan return among calling models with at least `minGraded` graded calls
 * that carry a return (ties: more such calls, then id). Null when none qualify.
 */
export function pickBestReturnModel(
  standings: readonly TopModelStanding[],
  minGraded = TOP_MODELS_MIN_GRADED,
): string | null {
  const avg = (s: TopModelStanding) => (s.sumSimReturnPct ?? 0) / (s.simCalls ?? 1);
  const eligible = standings.filter(
    (s) => s.calling && s.graded >= minGraded && (s.simCalls ?? 0) >= Math.max(minGraded, 1),
  );
  if (eligible.length === 0) return null;
  return [...eligible].sort(
    (a, b) => avg(b) - avg(a) || (b.simCalls ?? 0) - (a.simCalls ?? 0) || a.id.localeCompare(b.id),
  )[0]!.id;
}

/**
 * The window the ranking reads: the 24 hours of calls ending TOP_MODELS_GRADE_LAG_MINUTES before
 * the current refresh slot starts, so every call in it has been graded.
 */
export function topModelsWindow(now: Date): { since: Date; until: Date; slot: number } {
  const step = TOP_MODELS_REFRESH_MINUTES * 60_000;
  const slot = Math.floor(now.getTime() / step) * step;
  const until = slot - TOP_MODELS_GRADE_LAG_MINUTES * 60_000;
  return { since: new Date(until - TOP_MODELS_WINDOW_HOURS * 3_600_000), until: new Date(until), slot };
}

/**
 * The slot's stored pick, storing `fresh` first when the slot has none. The first process to read a
 * slot decides it; any other reads the stored one, so a pick made by the API and one made by the
 * worker can't differ. Models no longer on the roster are dropped from a stored pick.
 */
async function heldTopModels(
  slotStart: Date,
  fresh: string[] | null,
  roster: readonly string[],
): Promise<string[] | null> {
  await prisma.topModelsPick.createMany({ data: [{ slotStart, models: fresh ?? [] }], skipDuplicates: true });
  const held = await prisma.topModelsPick.findUnique({ where: { slotStart } });
  const models = (held?.models ?? fresh ?? []).filter((id) => roster.includes(id));
  return models.length > 0 ? models : null;
}

const cache = new Map<string, Promise<TopModels>>();

/** Test hook. */
export function resetTopModelsCache(): void {
  cache.clear();
}

/**
 * Today's top models (and best-return model) for this roster, read once per refresh slot per process. A failed read is
 * not kept, so the next caller retries it. `exams` are each model's latest exam record (the active
 * model's evalMetrics.exam), scored with its live record the way the champion is.
 */
export function loadTopModels(
  roster: readonly ContestantSpec[],
  lanes: readonly Lane[],
  canCall: (id: string) => boolean,
  exams: ReadonlyMap<string, CallRecord | undefined>,
  targets: PrecisionTargets,
  now: Date = new Date(),
): Promise<TopModels> {
  const { since, until, slot } = topModelsWindow(now);
  const ids = roster.map((c) => c.id);
  const calling = roster.filter((c) => c.control !== true && canCall(c.id)).map((c) => c.id);
  const lanesKey = lanes.map((l) => `${l.slot}=${l.name}`).join(",");
  const key = `${slot}|${ids.join(",")}|${calling.join(",")}|${lanesKey}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // One slot's answers are all a reader needs; older slots are dropped as a new one fills.
  for (const k of cache.keys()) if (!k.startsWith(`${slot}|`)) cache.delete(k);
  const scoreSince = new Date(until.getTime() - CHAMPION_WINDOW_DAYS * 86_400_000);
  const read = Promise.all([
    liveCallRecords(ids, since, lanes, { until }),
    liveCallRecords(ids, scoreSince, lanes, { until }),
  ]).then(async ([live, longLive]) => {
    const standings = ids.map((id) => {
      const r = live.get(id);
      return {
        score: compositeScore(longLive.get(id) ?? emptyRecord(), exams.get(id) ?? emptyRecord(), targets)
          .score,
        id,
        calling: calling.includes(id),
        graded: r?.graded ?? 0,
        wins: r?.wins ?? 0,
        simCalls: r?.simCalls ?? 0,
        sumSimReturnPct: r?.sumSimReturnPct ?? 0,
      };
    });
    return {
      top: await heldTopModels(new Date(slot), pickTopModels(standings), ids),
      best: pickBestReturnModel(standings),
      last24h: new Map(standings.map((s) => [s.id, last24hOf(s)])),
    };
  });
  cache.set(key, read);
  read.catch(() => cache.delete(key));
  return read;
}
