import type { ContestantSpec } from "./contestants.js";
import type { Lane } from "./evolution.js";
import { liveCallRecords } from "./laneStore.js";

/**
 * The default feed (user decision 2026-10-12): the calls of the three models with the best 2x hit
 * rate over the last 24 hours, combined. Everyone who follows the default sees it, and so do
 * guests. The single champion (champion.ts) still exists for what needs one model: the AI
 * reviewer, and the fallback below.
 *
 * Guards against noise:
 *  - a model needs TOP_MODELS_MIN_GRADED graded calls in the window to be ranked, so two lucky
 *    calls can't win a slot;
 *  - the ranking is recomputed on a fixed cadence (TOP_MODELS_REFRESH_MINUTES), aligned to the
 *    clock, so the API and the worker's Telegram dispatcher rank the same window and agree;
 *  - with fewer than TOP_MODELS_COUNT qualifying models the default stays on the single champion.
 *
 * The same read also names the "best" model (user decision 2026-10-12): the best average return
 * under the fixed exit plan over the same window, under the same floor.
 */

export const TOP_MODELS_COUNT = 3;
export const TOP_MODELS_WINDOW_HOURS = 24;
/** Graded calls in the window a model needs before it can take a slot. */
export const TOP_MODELS_MIN_GRADED = 30;
export const TOP_MODELS_REFRESH_MINUTES = 15;

export interface TopModelStanding {
  id: string;
  /** Can send now (has a usable cutoff, isn't a control seat). */
  calling: boolean;
  graded: number;
  wins: number;
  /** Graded calls with a simulated exit-plan return, and their sum in percent. */
  simCalls?: number;
  sumSimReturnPct?: number;
}

export interface TopModels {
  /** The default feed's models, best 2x rate first; null when too few qualify. */
  top: string[] | null;
  /** The best average exit-plan return; null when no model qualifies. */
  best: string | null;
}

/**
 * The `count` best 2x hit rates among calling models with at least `minGraded` graded calls,
 * best first (ties: more graded calls, then id). Null when fewer than `count` qualify.
 */
export function pickTopModels(
  standings: readonly TopModelStanding[],
  count = TOP_MODELS_COUNT,
  minGraded = TOP_MODELS_MIN_GRADED,
): string[] | null {
  const eligible = standings.filter((s) => s.calling && s.graded >= minGraded && s.graded > 0);
  if (eligible.length < count) return null;
  return [...eligible]
    .sort((a, b) => b.wins / b.graded - a.wins / a.graded || b.graded - a.graded || a.id.localeCompare(b.id))
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

/** The window the ranking reads: the 24 hours up to the start of the current refresh slot. */
export function topModelsWindow(now: Date): { since: Date; slot: number } {
  const step = TOP_MODELS_REFRESH_MINUTES * 60_000;
  const slot = Math.floor(now.getTime() / step) * step;
  return { since: new Date(slot - TOP_MODELS_WINDOW_HOURS * 3_600_000), slot };
}

const cache = new Map<string, Promise<TopModels>>();

/** Test hook. */
export function resetTopModelsCache(): void {
  cache.clear();
}

/**
 * Today's top models (and best-return model) for this roster, read once per refresh slot per process. A failed read is
 * not kept, so the next caller retries it.
 */
export function loadTopModels(
  roster: readonly ContestantSpec[],
  lanes: readonly Lane[],
  canCall: (id: string) => boolean,
  now: Date = new Date(),
): Promise<TopModels> {
  const { since, slot } = topModelsWindow(now);
  const ids = roster.map((c) => c.id);
  const calling = roster.filter((c) => c.control !== true && canCall(c.id)).map((c) => c.id);
  const lanesKey = lanes.map((l) => `${l.slot}=${l.name}`).join(",");
  const key = `${slot}|${ids.join(",")}|${calling.join(",")}|${lanesKey}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // One slot's answers are all a reader needs; older slots are dropped as a new one fills.
  for (const k of cache.keys()) if (!k.startsWith(`${slot}|`)) cache.delete(k);
  const read = liveCallRecords(ids, since, lanes).then((live) => {
    const standings = ids.map((id) => {
      const r = live.get(id);
      return {
        id,
        calling: calling.includes(id),
        graded: r?.graded ?? 0,
        wins: r?.wins ?? 0,
        simCalls: r?.simCalls ?? 0,
        sumSimReturnPct: r?.sumSimReturnPct ?? 0,
      };
    });
    return { top: pickTopModels(standings), best: pickBestReturnModel(standings) };
  });
  cache.set(key, read);
  read.catch(() => cache.delete(key));
  return read;
}
