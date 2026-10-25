/**
 * Keeps an open bubble map current (user ask 2026-10-25: an open map is always updating). It holds
 * an ask for the coin's next reading (GET /ext/v1/bubble/:mint/wait, answered the moment the
 * scanner writes one, or after 20 s with nothing) and calls `changed` when one is written, so the
 * map is re-read at once rather than on its next poll. The map's own poll stays as the fallback.
 * Nothing is held while the page is hidden; showing it again re-reads the map and resumes.
 */

/** A held ask's answer, or null when it failed (offline, a refused key, the worker asleep). */
export type WaitAnswer = { changed: boolean; pushed: boolean } | null;

/** Before asking again when no wait could be held (the API at capacity, or an older build). */
export const FOLLOW_IDLE_MS = 60_000;
/** The first retry after a failed ask; each further failure doubles it, up to FOLLOW_IDLE_MS. */
const FOLLOW_RETRY_MS = 2_000;

export interface FollowDeps {
  visible: () => boolean;
  onVisible: (listener: () => void) => () => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

const browserDeps: FollowDeps = {
  visible: () => document.visibilityState === "visible",
  onVisible: (listener) => {
    const handler = () => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id),
};

/** Follows one open map until the returned stop is called. */
export function followMap(
  wait: () => Promise<WaitAnswer>,
  changed: () => void,
  deps: FollowDeps = browserDeps,
): () => void {
  let live = true;
  let holding = false;
  let timer = 0;
  let failures = 0;
  const next = (ms: number) => {
    deps.clearTimer(timer);
    if (live) timer = deps.setTimer(() => void ask(), ms);
  };
  const ask = async () => {
    if (!live || holding) return;
    // Hidden: nothing held; the page coming back asks again.
    if (!deps.visible()) return;
    holding = true;
    let answer: WaitAnswer;
    try {
      answer = await wait();
    } catch {
      answer = null;
    } finally {
      holding = false;
    }
    if (!live) return;
    if (answer === null) {
      failures += 1;
      return next(Math.min(FOLLOW_IDLE_MS, FOLLOW_RETRY_MS * 2 ** (failures - 1)));
    }
    failures = 0;
    if (answer.changed) changed();
    next(answer.pushed ? 0 : FOLLOW_IDLE_MS);
  };
  const stopVisible = deps.onVisible(() => {
    // Whatever was written while hidden: read it now, then hold again.
    changed();
    if (!holding) next(0);
  });
  void ask();
  return () => {
    live = false;
    deps.clearTimer(timer);
    stopVisible();
  };
}
