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

/** The window the ranking reads: the 24 hours up to the start of the current refresh slot. */
export function topModelsWindow(now: Date): { since: Date; slot: number } {
  const step = TOP_MODELS_REFRESH_MINUTES * 60_000;
  const slot = Math.floor(now.getTime() / step) * step;
  return { since: new Date(slot - TOP_MODELS_WINDOW_HOURS * 3_600_000), slot };
}

const cache = new Map<string, Promise<string[] | null>>();

/** Test hook. */
export function resetTopModelsCache(): void {
  cache.clear();
}

/**
 * Today's top models for this roster, read once per refresh slot per process. A failed read is
 * not kept, so the next caller retries it.
 */
export function loadTopModels(
  roster: readonly ContestantSpec[],
  lanes: readonly Lane[],
  canCall: (id: string) => boolean,
  now: Date = new Date(),
): Promise<string[] | null> {
  const { since, slot } = topModelsWindow(now);
  const ids = roster.map((c) => c.id);
  const calling = roster.filter((c) => c.control !== true && canCall(c.id)).map((c) => c.id);
  const lanesKey = lanes.map((l) => `${l.slot}=${l.name}`).join(",");
  const key = `${slot}|${ids.join(",")}|${calling.join(",")}|${lanesKey}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // One slot's answers are all a reader needs; older slots are dropped as a new one fills.
  for (const k of cache.keys()) if (!k.startsWith(`${slot}|`)) cache.delete(k);
  const read = liveCallRecords(ids, since, lanes).then((live) =>
    pickTopModels(
      ids.map((id) => ({
        id,
        calling: calling.includes(id),
        graded: live.get(id)?.graded ?? 0,
        wins: live.get(id)?.wins ?? 0,
      })),
    ),
  );
  cache.set(key, read);
  read.catch(() => cache.delete(key));
  return read;
}
